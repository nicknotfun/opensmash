#!/usr/bin/env python3
"""Build and deploy the OpenSmash API; default is a no-cloud-call plan."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

LABEL = "managed-by"
OWNER = "opensmash-deploy"
LABEL_FLAGS = "app=opensmash,managed-by=opensmash-deploy"
DESCRIPTION = "Managed by OpenSmash deploy/gcp/site.py"
EXACT = {
    "web-prototype/package.json", "web-prototype/pnpm-lock.yaml", "web-prototype/pnpm-workspace.yaml",
    "web-prototype/index.html", "web-prototype/vite.config.js",
    "web-prototype/docker/pilot-api.Dockerfile", "web-prototype/docker/pilot-api.Dockerfile.dockerignore",
    "web-prototype/infra/pilot-site.mjs", "engines/melee/web/package.json",
    "engines/melee/web/package-lock.json", "engines/melee/web/public/catalog.json",
    "engines/melee/runtime/launch-options.json",
}
PREFIXES = (
    "web-prototype/src/", "web-prototype/public/", "web-prototype/server/", "web-prototype/shared/",
    "web-prototype/config/", "web-prototype/visual/", "engines/ssb64/launcher/",
    "engines/melee/server/", "engines/melee/launcher/", "engines/melee/web/app/", "engines/melee/web/lib/",
)
EXTENSIONS = {".js", ".mjs", ".jsx", ".ts", ".tsx", ".css", ".json", ".py", ".html", ".png", ".webp",
              ".jpg", ".jpeg", ".svg", ".ico", ".webmanifest", ".txt", ".mp3", ".wav", ".webm", ".glb",
              ".woff", ".woff2", ".ttf", ".otf", ".gif", ".mp4"}


def allowed_source(filename):
    parts = Path(filename).parts
    if not parts or Path(filename).is_absolute() or any(p in {"..", ".git", "node_modules"} or p.startswith(".env") for p in parts):
        return False
    if filename in EXACT:
        return True
    if filename.startswith("engines/melee/runtime/web/") and filename.endswith(".mjs") and len(parts) == 5:
        return True
    return filename.startswith(PREFIXES) and Path(filename).suffix.lower() in EXTENSIONS


def source_files(repo):
    result = subprocess.run(["git", "ls-files", "-z"], cwd=repo, check=True, capture_output=True)
    names = set(result.stdout.decode().split("\0")) | EXACT
    selected = sorted(name for name in names if allowed_source(name))
    for name in selected:
        filename = repo / name
        if not filename.is_file() or filename.is_symlink():
            raise ValueError(f"Build input must be an ordinary file: {name}")
        if not filename.resolve().is_relative_to(repo.resolve()):
            raise ValueError(f"Build input escapes repository: {name}")
    return selected


def stage_source(repo, destination, names, runtime=None, melee_runtime=None):
    digest = hashlib.sha256()
    for name in names:
        data = (repo / name).read_bytes()
        digest.update(name.encode() + b"\0" + hashlib.sha256(data).digest())
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for prefix, payload in (("ssb64-runtime", runtime), ("melee-browser-runtime", melee_runtime)):
        if not payload:
            continue
        runtime_root, runtime_names = payload
        if runtime_root.is_symlink() or not runtime_root.is_dir():
            raise ValueError("Runtime root changed or became a symlink before staging.")
        for name in runtime_names:
            filename = runtime_root / name
            if not filename.is_file() or filename.is_symlink() or not filename.resolve().is_relative_to(runtime_root.resolve()):
                raise ValueError(f"Runtime input changed or escaped its directory: {name}")
            for parent in filename.parents:
                if parent == runtime_root:
                    break
                if parent.is_symlink():
                    raise ValueError(f"Runtime directory became a symlink: {name}")
            data = filename.read_bytes()
            relative = prefix + "/" + name
            digest.update(relative.encode() + b"\0" + hashlib.sha256(data).digest())
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    # The allowlisted tree is the entire upload; never inherit gitignore rules
    # or ask gcloud to inspect the user's checkout for additional inputs.
    (destination / ".gcloudignore").write_text("# Already staged from a strict source allowlist.\n")
    return digest.hexdigest()[:24]


def validated_runtime(repo, runtime_root):
    # Validate the actual Wasm export and the entire input tree before even
    # describing a cloud resource. Validation rejects symlinks and ROM archives.
    result = subprocess.run(["node", str(repo / "web-prototype/infra/pilot-site.mjs"), "check-runtime", str(runtime_root)],
                            check=False, capture_output=True, text=True)
    if result.returncode:
        raise ValueError("SSB64 runtime preflight failed: " + result.stderr.strip())
    required = {"index.html", "BattleShip.js", "BattleShip.wasm", "manifest.json", "rom-extract.js", "torch-worker.js"}
    names = []
    for filename in runtime_root.rglob("*"):
        if not filename.is_file():
            continue
        name = filename.relative_to(runtime_root).as_posix()
        if name not in required and not name.startswith(("files/", "torch/")):
            continue
        if any(part.startswith(".") for part in filename.relative_to(runtime_root).parts) or filename.suffix.lower() in {".pem", ".key"}:
            raise ValueError(f"Private or hidden input in the packaged runtime: {name}")
        names.append(name)
    return sorted(names)


def validated_melee_runtime(repo, runtime_root):
    result = subprocess.run(["node", str(repo / "web-prototype/server/melee-browser-runtime.js"), "check", str(runtime_root)],
                            check=False, capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Melee browser runtime preflight failed: " + result.stderr.strip())
    data = json.loads(result.stdout)
    if data.get("controllerPorts") != 4 or data.get("containsGameData") is not False or not isinstance(data.get("files"), list):
        raise ValueError("Melee browser runtime preflight returned an invalid capability.")
    return data["files"]


def validated_config(repo, config_file):
    script = "import {readFileSync} from 'node:fs';import {siteConfiguration} from './web-prototype/infra/pilot-site.mjs';console.log(JSON.stringify(siteConfiguration(JSON.parse(readFileSync(process.argv[1],'utf8')))));"
    result = subprocess.run(["node", "--input-type=module", "-e", script, str(config_file.resolve())], cwd=repo, check=True, capture_output=True, text=True)
    return json.loads(result.stdout), json.loads(config_file.read_text())


def deployment_plan(config, raw, source="<staged-source>", private="<private-inputs>", tag="<source-sha>", with_runtime=False, with_melee_runtime=False):
    project, region = config["projectId"], config["region"]
    api = f"opensmash-api@{project}.iam.gserviceaccount.com"
    builder = f"opensmash-site-build@{project}.iam.gserviceaccount.com"
    repository, service = "opensmash-site", "opensmash-site"
    source_bucket = f"{project}-opensmash-build-source"
    image = f"{region}-docker.pkg.dev/{project}/{repository}/website:{tag}"
    operations = []

    def command(*args):
        return ["gcloud", *map(str, args), f"--project={project}", "--quiet"]

    def run(*args):
        operations.append({"run": command(*args)})

    def ensure(describe, create, check, after=None):
        operations.append({"describe": command(*describe, "--format=json"), "create": command(*create) if create else None,
                           "check": check, "after_create": command(*after) if after else None})

    def project_role(account, role):
        run("projects", "add-iam-policy-binding", project, f"--member=serviceAccount:{account}", f"--role={role}", "--condition=None")

    def bucket(name, public=False):
        url = f"gs://{name}"
        flags = ["--uniform-bucket-level-access"] + ([] if public else ["--public-access-prevention"])
        ensure(["storage", "buckets", "describe", url, "--raw"],
               ["storage", "buckets", "create", url, f"--location={region}", *flags],
               {"kind": "bucket", "path": "labels"},
               ["storage", "buckets", "update", url, f"--update-labels={LABEL_FLAGS}"])
        return url

    services = ["run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com",
                "secretmanager.googleapis.com", "iam.googleapis.com", "logging.googleapis.com", "storage.googleapis.com",
                "identitytoolkit.googleapis.com"]
    if config["mode"] == "full":
        services.append("firestore.googleapis.com")
    ensure(["projects", "describe", project], None, {"kind": "project", "projectId": project})
    run("services", "enable", *services)
    for account in (api, builder):
        ensure(["iam", "service-accounts", "describe", account],
               ["iam", "service-accounts", "create", account.split("@")[0], f"--description={DESCRIPTION}"],
               {"kind": "description", "value": DESCRIPTION})
    ensure(["artifacts", "repositories", "describe", repository, f"--location={region}"],
           ["artifacts", "repositories", "create", repository, f"--location={region}", "--repository-format=docker", f"--labels={LABEL_FLAGS}"],
           {"kind": "labels", "path": "labels"})
    source_url = bucket(source_bucket)
    run("storage", "buckets", "add-iam-policy-binding", source_url, f"--member=serviceAccount:{builder}", "--role=roles/storage.objectViewer")
    run("artifacts", "repositories", "add-iam-policy-binding", repository, f"--location={region}", f"--member=serviceAccount:{builder}", "--role=roles/artifactregistry.writer")
    project_role(builder, "roles/logging.logWriter")
    # Firebase session cookies and revocation checks are served by this API.
    project_role(api, "roles/firebaseauth.admin")
    for reference in sorted(set(config["secrets"].values())):
        name, version = reference.split(":")
        ensure(["secrets", "versions", "describe", version, f"--secret={name}"], None, {"kind": "secret", "state": "ENABLED"})
        run("secrets", "add-iam-policy-binding", name, f"--member=serviceAccount:{api}", "--role=roles/secretmanager.secretAccessor")
    if config["mode"] == "full":
        env = config["environment"]
        for name in (env["GCS_PRIVATE_BUCKET"], env["GCS_PUBLIC_BUCKET"]):
            url = bucket(name, public=name == env["GCS_PUBLIC_BUCKET"])
            run("storage", "buckets", "add-iam-policy-binding", url, f"--member=serviceAccount:{api}", "--role=roles/storage.objectAdmin")
            run("storage", "buckets", "add-iam-policy-binding", url, f"--member=serviceAccount:{api}", "--role=roles/storage.bucketViewer")
        run("storage", "buckets", "add-iam-policy-binding", f"gs://{env['GCS_PUBLIC_BUCKET']}", "--member=allUsers", "--role=roles/storage.objectViewer")
        run("storage", "buckets", "update", f"gs://{env['GCS_PUBLIC_BUCKET']}", f"--cors-file={private}/cors.json")
        ensure(["firestore", "databases", "describe", "--database=(default)"],
               ["firestore", "databases", "create", "--database=(default)", f"--location={region}", "--type=firestore-native"],
               {"kind": "firestore", "location": region})
        project_role(api, "roles/datastore.user")
        # TTL activation is a background maintenance operation; request acceptance
        # is sufficient for serving rooms, which also check expiry in the API.
        run("firestore", "fields", "ttls", "update", "expireAt", "--collection-group=handoffRooms", "--enable-ttl", "--database=(default)", "--async")
        if env.get("FIGHTER_WORKER_URL"):
            worker = raw.get("fighterWorkerService", "")
            worker_region = raw.get("fighterWorkerRegion", region)
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z]", worker):
                raise ValueError("fighterWorkerService must name the deployed Cloud Run worker.")
            if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", worker_region):
                raise ValueError("Invalid fighterWorkerRegion.")
            ensure(["run", "services", "describe", worker, f"--region={worker_region}"], None,
                   {"kind": "worker", "url": env["FIGHTER_WORKER_URL"]})
            run("run", "services", "add-iam-policy-binding", worker, f"--region={worker_region}", f"--member=serviceAccount:{api}", "--role=roles/run.invoker")
    # Check ownership before building/replacing an existing service.
    ensure(["run", "services", "describe", service, f"--region={region}"], None,
           {"kind": "labels", "path": "metadata.labels", "allow_missing": True})
    run("builds", "submit", source, f"--region={region}", f"--config={private}/cloudbuild.json",
        f"--service-account=projects/{project}/serviceAccounts/{builder}",
        f"--gcs-source-staging-dir={source_url}/source", f"--ignore-file={source}/.gcloudignore", "--timeout=1800")
    run("run", "deploy", service, f"--region={region}", f"--image={image}", f"--service-account={api}",
        "--execution-environment=gen2", "--ingress=all", "--allow-unauthenticated", "--port=8080",
        "--cpu=1", "--memory=1Gi", "--min-instances=0", "--max-instances=3", "--concurrency=40", "--timeout=900",
        f"--env-vars-file={private}/env.json",
        "--set-secrets=" + ",".join(f"{key}={value}" for key, value in sorted(config["secrets"].items())),
        f"--labels={LABEL_FLAGS}")
    run("run", "services", "describe", service, f"--region={region}", "--format=value(status.url)")
    build = {"steps": [{"name": "gcr.io/cloud-builders/docker", "args": ["build", "--file", "web-prototype/docker/pilot-api.Dockerfile", "--target", "pilot", "--tag", image, "."], "env": ["DOCKER_BUILDKIT=1"]}],
             "images": [image], "options": {"logging": "CLOUD_LOGGING_ONLY"}, "timeout": "1800s"}
    if with_runtime or with_melee_runtime:
        # Use an explicit recent Buildx client and its own BuildKit daemon;
        # Cloud Build's legacy Docker builder may lack named-context support.
        # /workspace is shared across steps. Store the client-side builder
        # registration there rather than depending on an image's HOME setting.
        buildx_env = ["BUILDX_CONFIG=/workspace/.opensmash-buildx"]
        target = "with-games" if with_runtime and with_melee_runtime else "with-ssb64" if with_runtime else "with-melee-browser"
        contexts = []
        if with_runtime:
            contexts.extend(["--build-context", "ssb64-runtime=./ssb64-runtime"])
        if with_melee_runtime:
            contexts.extend(["--build-context", "melee-browser-runtime=./melee-browser-runtime"])
        build["steps"] = [
            {"name": "docker:28-cli", "entrypoint": "docker", "env": buildx_env, "args": ["buildx", "create", "--name", "opensmash", "--driver", "docker-container", "--use"]},
            {"name": "docker:28-cli", "entrypoint": "docker", "env": buildx_env, "args": ["buildx", "build", "--builder", "opensmash", "--load", "--file", "web-prototype/docker/pilot-api.Dockerfile", "--target", target, *contexts, "--tag", image, "."]},
        ]
    return {"projectId": project, "region": region, "image": image, "operations": operations, "cloudBuild": build,
            "meleeBrowserRuntime": {"included": with_melee_runtime, "requirement": "--melee-browser-runtime requires a hash-verified generic four-controller browser build; no ISO or game workspace is uploaded."},
            "runtime": {"included": with_runtime, "requirement": "--ssb64-runtime pointing to a locally validated patched web-dist is required to include the SSB64 engine; full service config alone does not include a game."}}


def verify_resource(data, check, project_number=None):
    kind = check["kind"]
    if kind in {"labels", "bucket"}:
        labels = data
        for part in check["path"].split("."):
            labels = labels.get(part, {})
        if labels.get(LABEL) != OWNER or labels.get("app") != "opensmash":
            raise ValueError("Existing resource is not labeled as owned by this OpenSmash website deployment; refusing to mutate it.")
        if kind == "bucket" and (not project_number or str(data.get("project_number", data.get("projectNumber", ""))) != str(project_number)):
            raise ValueError("Existing bucket belongs to another project or its project cannot be verified.")
    elif kind == "project" and (data.get("projectId") != check["projectId"] or data.get("lifecycleState") != "ACTIVE" or not data.get("projectNumber") or data.get("labels", {}).get("app") != "opensmash" or data.get("labels", {}).get(LABEL) != OWNER):
        raise ValueError("Requested GCP project is not active, does not match the config, or lacks the OpenSmash ownership labels.")
    elif kind == "description" and data.get("description") != check["value"]:
        raise ValueError("Existing service account is not owned by this deployment.")
    elif kind == "secret" and data.get("state") != check["state"]:
        raise ValueError("Required Secret Manager version is not enabled.")
    elif kind == "firestore" and (data.get("type") != "FIRESTORE_NATIVE" or data.get("locationId") != check["location"]):
        raise ValueError("Existing default Firestore database has another type/location; it will not be altered.")
    elif kind == "worker" and data.get("status", {}).get("url") != check["url"]:
        raise ValueError("Worker service URL does not match the validated configuration.")



IAM_BINDING_COMMANDS = (
    ("projects", "add-iam-policy-binding"),
    ("storage", "buckets", "add-iam-policy-binding"),
    ("artifacts", "repositories", "add-iam-policy-binding"),
    ("secrets", "add-iam-policy-binding"),
    ("run", "services", "add-iam-policy-binding"),
)
IAM_RETRY_DELAYS = (1, 2, 4, 8)
IAM_POLICY_CONFLICT = re.compile(
    r"\bconcurrent\s+(?:iam\s+)?policy\s+(?:changes?|updates?)\b"
    r"|\bpolicy\b[^.\n]{0,160}\bconflicting\s+update\b"
    r"|\betag\b[^\n]{0,120}\b(?:mismatch(?:ed)?|does not match|did not match)\b"
    r"|\bmismatched\s+etag\b", re.IGNORECASE)


def run_command(command, runner, sleep):
    # These commands re-read the policy and add an existing binding safely.
    # Retry the entire CLI operation so its next write uses the current etag.
    retryable = command[0] == "gcloud" and any(
        tuple(command[1:1 + len(prefix)]) == prefix for prefix in IAM_BINDING_COMMANDS)
    if not retryable:
        return runner(command, check=True)
    for attempt in range(len(IAM_RETRY_DELAYS) + 1):
        try:
            result = runner(command, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            if attempt < len(IAM_RETRY_DELAYS) and IAM_POLICY_CONFLICT.search(error.stderr or ""):
                delay = IAM_RETRY_DELAYS[attempt]
                print(f"IAM policy changed concurrently; retrying in {delay}s "
                      f"(attempt {attempt + 2}/{len(IAM_RETRY_DELAYS) + 1}).", file=sys.stderr, flush=True)
                sleep(delay)
                continue
            # Preserve the CLI diagnostic and original failure for callers.
            if error.stdout:
                print(error.stdout, end="", flush=True)
            if error.stderr:
                print(error.stderr, end="", file=sys.stderr, flush=True)
            raise
        if result.stdout:
            print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr, flush=True)
        return result


def execute(plan, runner=subprocess.run, sleep=time.sleep):
    project_number = None
    for operation in plan["operations"]:
        if "run" in operation:
            print("Running:", json.dumps(operation["run"]), flush=True)
            run_command(operation["run"], runner, sleep)
            continue
        result = runner(operation["describe"], capture_output=True, text=True)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            verify_resource(data, operation["check"], project_number)
            if operation["check"]["kind"] == "project":
                project_number = data["projectNumber"]
            continue
        # Missing permissions, disabled APIs and transient errors must not be
        # treated as absence or used as a reason to create/replace resources.
        missing = re.search(r"\bNOT_FOUND\b|\b404\b|does not exist|was not found", result.stderr, re.IGNORECASE)
        # Cloud Run's CLI emits this message without a NOT_FOUND status code.
        describe = operation["describe"]
        if describe[:4] == ["gcloud", "run", "services", "describe"] and len(describe) > 4:
            expected = f"ERROR: (gcloud.run.services.describe) Cannot find service [{describe[4]}]"
            missing = missing or result.stderr.strip() == expected
        if not missing:
            raise RuntimeError(result.stderr.strip() or "Resource inspection failed.")
        if operation["create"] is None:
            if operation["check"].get("allow_missing"):
                continue
            raise RuntimeError("Required resource is missing: " + " ".join(operation["describe"]))
        runner(operation["create"], check=True)
        if operation.get("after_create"):
            runner(operation["after_create"], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--ssb64-runtime", type=Path, help="Optional patched web-dist; validated and hashed before upload. No ROM/disc/archive or symlink is accepted.")
    parser.add_argument("--melee-browser-runtime", type=Path, help="Optional generic four-controller browser runtime; entire manifest, hashes and Wasm exports are validated before upload. No game data or symlinks accepted.")
    parser.add_argument("--apply", action="store_true", help="Run the displayed plan against GCP; without this flag no cloud calls occur.")
    args = parser.parse_args()
    repo = args.repo.resolve()
    config, raw = validated_config(repo, args.config)
    if (args.project, args.region) != (config["projectId"], config["region"]):
        raise ValueError("CLI project and region must match the validated config.")
    runtime = None
    if args.ssb64_runtime:
        runtime_root = args.ssb64_runtime.absolute()
        runtime = (runtime_root, validated_runtime(repo, runtime_root))
    melee_runtime = None
    if args.melee_browser_runtime:
        melee_root = args.melee_browser_runtime.absolute()
        melee_runtime = (melee_root, validated_melee_runtime(repo, melee_root))
    names = source_files(repo)
    if not args.apply:
        print(json.dumps({**deployment_plan(config, raw, with_runtime=runtime is not None, with_melee_runtime=melee_runtime is not None), "sourceFiles": names, "runtimeFiles": runtime[1] if runtime else [], "meleeBrowserRuntimeFiles": melee_runtime[1] if melee_runtime else []}, indent=2))
        return
    with tempfile.TemporaryDirectory(prefix="opensmash-site-deploy-") as temporary:
        work = Path(temporary)
        source, private = work / "source", work / "private"
        source.mkdir()
        private.mkdir(mode=0o700)
        tag = stage_source(repo, source, names, runtime, melee_runtime)
        if runtime:
            # Recheck the copied bytes to catch any input changes during staging.
            validated_runtime(repo, source / "ssb64-runtime")
        if melee_runtime:
            validated_melee_runtime(repo, source / "melee-browser-runtime")
        plan = deployment_plan(config, raw, str(source), str(private), tag, with_runtime=runtime is not None, with_melee_runtime=melee_runtime is not None)
        (private / "cloudbuild.json").write_text(json.dumps(plan["cloudBuild"]))
        (private / "env.json").write_text(json.dumps(config["environment"]))
        (private / "cors.json").write_text(json.dumps([{"origin": [config["siteOrigin"]], "method": ["GET", "HEAD"], "responseHeader": ["Content-Type", "Content-Encoding", "Cache-Control", "ETag"], "maxAgeSeconds": 3600}]))
        execute(plan)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
