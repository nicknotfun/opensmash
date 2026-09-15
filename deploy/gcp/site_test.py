import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("opensmash_site_deploy", Path(__file__).with_name("site.py"))
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


def config(full=False, worker=False):
    env = {"PUBLIC_ORIGIN": "https://smash.not.fun", "CREATION_ENABLED": "0"}
    secrets = {"COOKIE_SECRET": "opensmash-cookie:1", "TURNSTILE_SECRET_KEY": "opensmash-turnstile:1"}
    if full:
        env.update({"GCS_PRIVATE_BUCKET": "test-smash-private", "GCS_PUBLIC_BUCKET": "test-smash-public"})
        secrets["MELEE_SERVICE_TOKEN"] = "opensmash-melee:1"
    if worker:
        env["FIGHTER_WORKER_URL"] = "https://fighter-worker.example.run.app"
        secrets["OPENAI_API_KEY"] = "opensmash-openai:1"
    return {"projectId": "test-smash-project", "region": "us-central1", "mode": "full" if full else "site",
            "siteOrigin": "https://smash.not.fun", "environment": env, "secrets": secrets}


class PlanTests(unittest.TestCase):
    def test_minimal_mode_builds_restricted_context_and_keeps_cloud_run_public_for_worker(self):
        plan = site.deployment_plan(config(), {})
        commands = [op["run"] for op in plan["operations"] if "run" in op]
        cloud_run = next(command for command in commands if command[1:3] == ["run", "deploy"])
        self.assertIn("--ingress=all", cloud_run)
        self.assertIn("--allow-unauthenticated", cloud_run)
        self.assertIn("--service-account=opensmash-api@test-smash-project.iam.gserviceaccount.com", cloud_run)
        self.assertTrue(any(arg.startswith("--env-vars-file=<private-inputs>/") for arg in cloud_run))
        self.assertFalse(any("firestore" in command for command in commands))
        self.assertFalse(any("roles/editor" in command or "roles/owner" in command for command in commands))
        build = next(command for command in commands if command[1:3] == ["builds", "submit"])
        self.assertEqual(build[3], "<staged-source>")
        self.assertIn("--config=<private-inputs>/cloudbuild.json", build)
        self.assertIn("--ignore-file=<staged-source>/.gcloudignore", build)
        self.assertEqual(plan["cloudBuild"]["steps"][0]["args"][4:6], ["pilot", "--tag"])

    def test_runtime_is_explicit_and_uses_a_named_context_only_when_supplied(self):
        without = site.deployment_plan(config(True), {})
        self.assertFalse(without["runtime"]["included"])
        self.assertIn("--ssb64-runtime", without["runtime"]["requirement"])
        with_runtime = site.deployment_plan(config(True), {}, with_runtime=True)
        build = with_runtime["cloudBuild"]["steps"][-1]["args"]
        self.assertEqual(build[build.index("--target") + 1], "with-ssb64")
        self.assertEqual(build[build.index("--build-context") + 1], "ssb64-runtime=./ssb64-runtime")
        self.assertIn("--load", build)
        self.assertTrue(with_runtime["runtime"]["included"])
        for step in with_runtime["cloudBuild"]["steps"]:
            self.assertIn("BUILDX_CONFIG=/workspace/.opensmash-buildx", step["env"])

    def test_browser_melee_named_context_can_be_combined_without_dropping_smash64(self):
        for ssb64 in (False, True):
            plan = site.deployment_plan(config(True), {}, with_runtime=ssb64, with_melee_runtime=True)
            build = plan["cloudBuild"]["steps"][-1]["args"]
            self.assertEqual(build[build.index("--target") + 1], "with-games" if ssb64 else "with-melee-browser")
            self.assertIn("melee-browser-runtime=./melee-browser-runtime", build)
            self.assertEqual("ssb64-runtime=./ssb64-runtime" in build, ssb64)
            self.assertTrue(plan["meleeBrowserRuntime"]["included"])
            self.assertEqual(plan["runtime"]["included"], ssb64)
        self.assertFalse(site.deployment_plan(config(True), {})["meleeBrowserRuntime"]["included"])

    def test_full_mode_grants_assets_and_secrets_at_resource_scope(self):
        plan = site.deployment_plan(config(True, True), {"fighterWorkerService": "fighter-worker"})
        commands = [op["run"] for op in plan["operations"] if "run" in op]
        project_bindings = [cmd for cmd in commands if cmd[1:3] == ["projects", "add-iam-policy-binding"]]
        self.assertFalse(any("--role=roles/storage.objectAdmin" in cmd for cmd in project_bindings))
        self.assertFalse(any("--role=roles/secretmanager.secretAccessor" in cmd for cmd in project_bindings))
        public = [cmd for cmd in commands if "--member=allUsers" in cmd]
        self.assertEqual(len(public), 1)
        self.assertIn("gs://test-smash-public", public[0])
        self.assertNotIn("gs://test-smash-private", public[0])
        worker = next(cmd for cmd in commands if "--role=roles/run.invoker" in cmd)
        self.assertEqual(worker[4], "fighter-worker")
        checks = [op["check"] for op in plan["operations"] if "check" in op]
        self.assertIn({"kind": "worker", "url": "https://fighter-worker.example.run.app"}, checks)
        self.assertIn({"kind": "firestore", "location": "us-central1"}, checks)
        self.assertTrue(any(op.get("describe", [])[1:4] == ["secrets", "versions", "describe"] for op in plan["operations"]))
        self.assertFalse(any("access" in cmd for cmd in commands))
        ttl = next(cmd for cmd in commands if cmd[1:5] == ["firestore", "fields", "ttls", "update"])
        self.assertIn("--enable-ttl", ttl)
        self.assertIn("--async", ttl)

    def test_bucket_inspection_uses_raw_metadata_for_project_ownership(self):
        for full in (False, True):
            with self.subTest(full=full):
                plan = site.deployment_plan(config(full), {})
                inspections = [op["describe"] for op in plan["operations"]
                               if op.get("check", {}).get("kind") == "bucket"]
                self.assertEqual(len(inspections), 3 if full else 1)
                for command in inspections:
                    self.assertEqual(command[1:4], ["storage", "buckets", "describe"])
                    self.assertIn("--raw", command)
                    self.assertIn("--format=json", command)

    def test_worker_resource_name_cannot_be_guessed_from_url_or_inject_flags(self):
        for raw in ({}, {"fighterWorkerService": "--project=another"}, {"fighterWorkerService": "worker", "fighterWorkerRegion": "us;bad"}):
            with self.assertRaises(ValueError):
                site.deployment_plan(config(True, True), raw)

    def test_source_allowlist_excludes_checkout_secrets_game_data_and_dependencies(self):
        for filename in (".git/config", "web-prototype/.env", "web-prototype/src/.env.production", "web-prototype/node_modules/react/index.js",
                         "private/key.json", "web-prototype/config/auth.pem", "web-prototype/public/game.iso", "engines/melee/melee/GAME_FILE_SYS/boot.bin",
                         "../web-prototype/src/App.jsx", "/web-prototype/src/App.jsx"):
            self.assertFalse(site.allowed_source(filename), filename)
        for filename in ("web-prototype/public/ssb64-netplay.js", "engines/melee/runtime/web/presentation.mjs", "web-prototype/docker/pilot-api.Dockerfile"):
            self.assertTrue(site.allowed_source(filename), filename)

    def test_staging_preserves_exact_bytes_and_does_not_copy_private_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo, output = root / "repo", root / "upload"
            (repo / "web-prototype/src").mkdir(parents=True)
            output.mkdir()
            filename = "web-prototype/src/App.jsx"
            (repo / filename).write_bytes(b"export default 'fixture';\n")
            (repo / "credentials.json").write_text("private fixture")
            tag = site.stage_source(repo, output, [filename])
            self.assertEqual((output / filename).read_bytes(), (repo / filename).read_bytes())
            self.assertFalse((output / "credentials.json").exists())
            self.assertEqual(len(tag), 24)
            (repo / filename).write_text("changed")
            self.assertNotEqual(site.stage_source(repo, output, [filename]), tag)


def runtime_fixture(root):
    export = b"port_netplay_version"
    export_section = bytes([1, len(export)]) + export + bytes([0, 0])
    wasm = bytes([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,len(export_section)]) + export_section + bytes([10,6,1,4,0,65,2,11])
    root.mkdir()
    for filename in ("index.html", "BattleShip.js", "manifest.json", "rom-extract.js", "torch-worker.js"):
        (root / filename).write_text("fixture")
    (root / "BattleShip.wasm").write_bytes(wasm)
    for directory in ("files", "torch"):
        (root / directory).mkdir()
        (root / directory / "module.js").write_text("fixture")


class RuntimeTests(unittest.TestCase):
    repo = Path(__file__).resolve().parents[2]

    def test_bad_runtime_is_rejected_before_any_cloud_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "runtime"
            runtime_fixture(root)
            (root / "files/BattleShip.o2r").write_text("ROM-derived fixture")
            argv = ["site.py", "--project", "test-smash-project", "--region", "us-central1", "--config", "unused.json", "--ssb64-runtime", str(root), "--apply"]
            with mock.patch.object(site.sys, "argv", argv), mock.patch.object(site, "validated_config", return_value=(config(True), {})), mock.patch.object(site, "execute") as execute:
                with self.assertRaisesRegex(ValueError, "runtime preflight failed"):
                    site.main()
                execute.assert_not_called()

    def test_runtime_symlinks_are_rejected_by_real_preflight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "runtime"
            runtime_fixture(root)
            (root / "torch/link.js").symlink_to(root / "BattleShip.js")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                site.validated_runtime(self.repo, root)

    def test_only_packaged_runtime_files_are_staged_and_hashed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root, repo, target = base / "runtime", base / "repo", base / "upload"
            runtime_fixture(root)
            repo.mkdir()
            target.mkdir()
            (root / "private-config.json").write_text("not a runtime input")
            names = site.validated_runtime(self.repo, root)
            self.assertNotIn("private-config.json", names)
            tag = site.stage_source(repo, target, [], (root, names))
            self.assertEqual((target / "ssb64-runtime/BattleShip.wasm").read_bytes(), (root / "BattleShip.wasm").read_bytes())
            self.assertFalse((target / "ssb64-runtime/private-config.json").exists())
            (root / "torch/module.js").write_text("changed runtime")
            self.assertNotEqual(site.stage_source(repo, target, [], (root, names)), tag)
            self.assertEqual(site.validated_runtime(self.repo, target / "ssb64-runtime"), names)


def melee_runtime_fixture(root):
    exports = [b"OpenSmashControllerPorts", b"SetControllerState", b"OpenSmashReadController"]
    section = bytes([len(exports)]) + b"".join(bytes([len(name)]) + name + bytes([0, 0]) for name in exports)
    wasm = bytes([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, len(section)]) + section + bytes([10, 6, 1, 4, 0, 65, 4, 11])
    core = "cores/dolphin/dolphin-core-upstream"
    revision = "7e38409ace3dda709c178312ff63fd92a3653cc7"
    names = ["src/core-host.js", "src/upstream-worker-adapter.js", "src/upstream-discio-worker.js", "src/upstream-worker-protocol.js", "src/audio.js", "LICENSE", "SOURCE.md", "provenance/dolphin-core-abi-v1.json"]
    files = {name: b"fixture" for name in names}
    files[core + ".js"], files[core + ".wasm"] = b"generic runtime", wasm
    files[core + ".build.json"] = json.dumps({"revision": revision, "controllerPorts": 4, "containsGameData": False, "artifacts": {
        "dolphin-core-upstream.wasm": hashlib.sha256(wasm).hexdigest(),
        "dolphin-core-upstream.js": hashlib.sha256(files[core + ".js"]).hexdigest(),
    }}).encode()
    root.mkdir()
    for name, data in files.items():
        filename = root / name
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_bytes(data)
    manifest = {"protocol": 1, "engine": "melee", "runtime": "wasm-dolphin", "revision": revision, "controllerPorts": 4,
                "containsGameData": False, "sharedMemoryBytes": 1610612736,
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    (root / "manifest.json").write_text(json.dumps(manifest))


class MeleeBrowserRuntimeTests(unittest.TestCase):
    repo = Path(__file__).resolve().parents[2]

    def test_real_preflight_and_combined_staging_preserve_both_engine_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            melee, ssb64, repo, output = base / "melee", base / "ssb64", base / "repo", base / "upload"
            melee_runtime_fixture(melee)
            runtime_fixture(ssb64)
            repo.mkdir()
            output.mkdir()
            melee_names = site.validated_melee_runtime(self.repo, melee)
            ssb64_names = site.validated_runtime(self.repo, ssb64)
            tag = site.stage_source(repo, output, [], (ssb64, ssb64_names), (melee, melee_names))
            self.assertEqual(len(tag), 24)
            self.assertTrue((output / "ssb64-runtime/BattleShip.wasm").is_file())
            self.assertTrue((output / "melee-browser-runtime/cores/dolphin/dolphin-core-upstream.wasm").is_file())
            self.assertEqual(site.validated_melee_runtime(self.repo, output / "melee-browser-runtime"), melee_names)
            (melee / "src/audio.js").write_text("changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                site.validated_melee_runtime(self.repo, melee)

    def test_generic_runtime_preflight_blocks_game_files_and_symlinks_before_cloud_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "runtime"
            melee_runtime_fixture(root)
            (root / "game.iso").write_text("private fixture")
            argv = ["site.py", "--project", "test-smash-project", "--region", "us-central1", "--config", "unused.json", "--melee-browser-runtime", str(root), "--apply"]
            with mock.patch.object(site.sys, "argv", argv), mock.patch.object(site, "validated_config", return_value=(config(True), {})), mock.patch.object(site, "execute") as execute:
                with self.assertRaisesRegex(ValueError, "Melee browser runtime preflight failed"):
                    site.main()
                execute.assert_not_called()
            (root / "game.iso").unlink()
            link = Path(temporary) / "link"
            link.symlink_to(root)
            with self.assertRaisesRegex(ValueError, "symlink"):
                site.validated_melee_runtime(self.repo, link)


class ExecutionTests(unittest.TestCase):
    iam_command = ["gcloud", "projects", "add-iam-policy-binding", "test-smash-project",
                   "--member=serviceAccount:api@test-smash-project.iam.gserviceaccount.com",
                   "--role=roles/datastore.user"]

    def test_iam_policy_conflicts_retry_the_whole_command_then_succeed(self):
        command = self.iam_command
        errors = [
            "ABORTED: The policy was the subject of a conflicting update. Please retry the whole read-modify-write with exponential backoff.",
            "ABORTED: The provided etag does not match the current policy.",
        ]
        runner = mock.Mock(side_effect=[*(subprocess.CalledProcessError(1, command, stderr=error) for error in errors),
                                        subprocess.CompletedProcess(command, 0, "updated\n", "")])
        sleep = mock.Mock()
        with mock.patch.object(site.sys, "stdout"), mock.patch.object(site.sys, "stderr"):
            site.execute({"operations": [{"run": command}]}, runner, sleep)
        self.assertEqual(runner.call_count, 3)
        for call in runner.call_args_list:
            self.assertEqual(call, mock.call(command, check=True, capture_output=True, text=True))
        self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2)])

    def test_iam_nonconflict_failures_are_not_retried(self):
        for diagnostic in ("PERMISSION_DENIED: missing setIamPolicy permission", "HTTP 409: resource already exists", "ABORTED: request failed"):
            with self.subTest(diagnostic=diagnostic):
                error = subprocess.CalledProcessError(1, self.iam_command, stderr=diagnostic)
                runner, sleep = mock.Mock(side_effect=error), mock.Mock()
                with mock.patch.object(site.sys, "stdout"), mock.patch.object(site.sys, "stderr") as stderr:
                    with self.assertRaises(subprocess.CalledProcessError) as raised:
                        site.execute({"operations": [{"run": self.iam_command}]}, runner, sleep)
                    self.assertIs(raised.exception, error)
                    self.assertIn(mock.call(diagnostic), stderr.write.call_args_list)
                runner.assert_called_once()
                sleep.assert_not_called()

    def test_iam_conflict_retries_are_bounded(self):
        error = subprocess.CalledProcessError(1, self.iam_command, stderr="ABORTED: There were concurrent policy changes.")
        runner, sleep = mock.Mock(side_effect=error), mock.Mock()
        with mock.patch.object(site.sys, "stdout"), mock.patch.object(site.sys, "stderr"):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                site.execute({"operations": [{"run": self.iam_command}]}, runner, sleep)
        self.assertIs(raised.exception, error)
        self.assertEqual(runner.call_count, 5)
        self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2), mock.call(4), mock.call(8)])

    def test_nonbinding_operations_are_never_retried(self):
        for command in (["gcloud", "run", "deploy", "opensmash-site"],
                        ["gcloud", "projects", "set-iam-policy", "test-smash-project", "policy.json"],
                        ["gcloud", "secrets", "create", "add-iam-policy-binding"]):
            with self.subTest(command=command):
                error = subprocess.CalledProcessError(1, command, stderr="There were concurrent policy changes.")
                runner, sleep = mock.Mock(side_effect=error), mock.Mock()
                with mock.patch.object(site.sys, "stdout"):
                    with self.assertRaises(subprocess.CalledProcessError):
                        site.execute({"operations": [{"run": command}]}, runner, sleep)
                runner.assert_called_once_with(command, check=True)
                sleep.assert_not_called()

    def test_target_project_must_be_active_and_owned(self):
        data = {"projectId": "test-smash-project", "projectNumber": "123", "lifecycleState": "ACTIVE"}
        check = {"kind": "project", "projectId": "test-smash-project"}
        with self.assertRaisesRegex(ValueError, "ownership labels"):
            site.verify_resource(data, check)
        data["labels"] = {"app": "opensmash", "managed-by": "opensmash-deploy"}
        site.verify_resource(data, check)
        data["labels"]["app"] = "unrelated"
        with self.assertRaises(ValueError):
            site.verify_resource(data, check)

    def test_existing_foreign_resource_is_not_modified(self):
        calls = []
        def runner(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, json.dumps({"labels": {"app": "another"}}), "")
        plan = {"operations": [{"describe": ["describe"], "create": ["create"], "check": {"kind": "labels", "path": "labels"}}, {"run": ["mutate"]}]}
        with self.assertRaisesRegex(ValueError, "refusing to mutate"):
            site.execute(plan, runner)
        self.assertEqual(calls, [["describe"]])

    def test_permission_failure_does_not_become_a_create(self):
        calls = []
        def runner(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1, "", "PERMISSION_DENIED: forbidden")
        plan = {"operations": [{"describe": ["describe"], "create": ["create"], "check": {"kind": "labels", "path": "labels"}}]}
        with self.assertRaisesRegex(RuntimeError, "PERMISSION_DENIED"):
            site.execute(plan, runner)
        self.assertEqual(calls, [["describe"]])

    def test_cloud_run_cli_missing_service_message_allows_first_deploy_only(self):
        describe = ["gcloud", "run", "services", "describe", "opensmash-site"]
        operation = {"describe": describe, "create": None,
                     "check": {"kind": "labels", "path": "metadata.labels", "allow_missing": True}}
        missing = "ERROR: (gcloud.run.services.describe) Cannot find service [opensmash-site]"
        runner = mock.Mock(return_value=subprocess.CompletedProcess(describe, 1, "", missing + "\n"))
        site.execute({"operations": [operation]}, runner)
        runner.assert_called_once_with(describe, capture_output=True, text=True)
        for diagnostic in (missing.replace("opensmash-site", "another-service"),
                           "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: forbidden",
                           missing + "\nPERMISSION_DENIED"):
            with self.subTest(diagnostic=diagnostic):
                runner = mock.Mock(return_value=subprocess.CompletedProcess(describe, 1, "", diagnostic))
                with self.assertRaises(RuntimeError):
                    site.execute({"operations": [operation]}, runner)
                runner.assert_called_once()

    def test_missing_owned_resource_is_created_and_labeled(self):
        calls = []
        def runner(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1 if command == ["describe"] else 0, "", "NOT_FOUND")
        site.execute({"operations": [{"describe": ["describe"], "create": ["create"], "after_create": ["label"], "check": {"kind": "labels", "path": "labels"}}]}, runner)
        self.assertEqual(calls, [["describe"], ["create"], ["label"]])

    def test_matching_labels_do_not_authorize_a_bucket_in_another_project(self):
        data = {"labels": {"app": "opensmash", "managed-by": "opensmash-deploy"}, "project_number": "123"}
        with self.assertRaisesRegex(ValueError, "another project"):
            site.verify_resource(data, {"kind": "bucket", "path": "labels"}, "456")
        site.verify_resource(data, {"kind": "bucket", "path": "labels"}, "123")

    def test_existing_database_or_worker_mismatch_requires_explicit_resolution(self):
        with self.assertRaises(ValueError):
            site.verify_resource({"type": "DATASTORE_MODE", "locationId": "us-central1"}, {"kind": "firestore", "location": "us-central1"})
        with self.assertRaises(ValueError):
            site.verify_resource({"status": {"url": "https://unrelated.run.app"}}, {"kind": "worker", "url": "https://expected.run.app"})


if __name__ == "__main__":
    unittest.main()
