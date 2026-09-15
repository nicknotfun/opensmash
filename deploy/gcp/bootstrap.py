#!/usr/bin/env python3
"""Create an isolated OpenSmash project and its Firebase web identity.

Requires an authenticated gcloud CLI. Secret values never enter the output.
Plan is the default; --apply creates resources in the specified NEW project.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

LABELS = {"app": "opensmash", "managed-by": "opensmash-deploy"}
SERVICES = ["cloudbilling.googleapis.com", "serviceusage.googleapis.com",
            "firebase.googleapis.com", "firebasehosting.googleapis.com",
            "identitytoolkit.googleapis.com", "apikeys.googleapis.com",
            "secretmanager.googleapis.com", "iam.googleapis.com",
            "cloudbuild.googleapis.com", "artifactregistry.googleapis.com",
            "run.googleapis.com", "compute.googleapis.com", "firestore.googleapis.com"]


def validate(project, billing, domain):
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("Use a valid 6–30 character GCP project ID.")
    if not re.fullmatch(r"[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}", billing):
        raise ValueError("Use a billing account ID such as 012ABC-345DEF-678ABC.")
    if not re.fullmatch(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain) or "." not in domain:
        raise ValueError("Use a hostname without a scheme, path, or port.")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in domain.split(".")):
        raise ValueError("Invalid domain label.")


def auth_update(existing, domain):
    # Merge authorized domains so resuming does not remove an existing callback.
    return {"authorizedDomains": sorted(set(existing.get("authorizedDomains", [])) | {domain}),
            "signIn": {"email": {"enabled": True, "passwordRequired": False}}}


class Cloud:
    def __init__(self, gcloud, project):
        self.gcloud, self.project = gcloud, project

    def command(self, *args):
        result = subprocess.run([self.gcloud, *args, "--quiet", "--format=json"],
                                text=True, capture_output=True)
        if result.returncode:
            # CLI commands here contain no secret values. Token calls are separate.
            raise RuntimeError(result.stderr.strip() or "gcloud failed")
        return json.loads(result.stdout or "null")

    def api(self, host, path, method="GET", body=None, missing=False):
        if host not in {"firebase.googleapis.com", "identitytoolkit.googleapis.com",
                        "firebasehosting.googleapis.com"} or not path.startswith("/"):
            raise ValueError("Unsupported Google API endpoint")
        token = subprocess.run([self.gcloud, "auth", "print-access-token", "--quiet"],
                               text=True, capture_output=True, check=True).stdout.strip()
        request = Request("https://" + host + path, method=method,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Authorization": "Bearer " + token,
                                   "Content-Type": "application/json",
                                   "X-Goog-User-Project": self.project})
        try:
            with urlopen(request, timeout=60) as response:
                return json.loads(response.read() or "{}")
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            # Avoid logging an HTTP response that might contain provider secrets.
            raise RuntimeError(f"{method} {host}{path} returned HTTP {error.code}") from None

    def operation(self, value):
        deadline = time.monotonic() + 600
        while not value.get("done"):
            name = value.get("name", "")
            if not re.fullmatch(r"operations/[a-zA-Z0-9_./:-]+", name):
                raise RuntimeError("Unexpected Firebase operation name")
            if time.monotonic() > deadline:
                raise RuntimeError("Firebase operation timed out; rerun to inspect/resume.")
            time.sleep(3)
            value = self.api("firebase.googleapis.com", "/v1beta1/" + name)
        if value.get("error"):
            raise RuntimeError("Firebase operation failed: " + str(value["error"].get("code", "unknown")))
        return value.get("response", {})


def bootstrap(cloud, billing, domain):
    project = cloud.project
    matches = cloud.command("projects", "list", "--filter=projectId=" + project)
    if matches:
        existing = next((item for item in matches if item["projectId"] == project), None)
        if not existing or any(existing.get("labels", {}).get(k) != v for k, v in LABELS.items()):
            raise RuntimeError("The project already exists and was not created by this bootstrap. Choose a new project ID.")
    else:
        cloud.command("projects", "create", project, "--name=OpenSmash",
                      "--labels=" + ",".join(k + "=" + v for k, v in LABELS.items()))
    info = cloud.command("billing", "projects", "describe", project)
    current = (info or {}).get("billingAccountName", "")
    if current and current != "billingAccounts/" + billing:
        raise RuntimeError("The project is linked to a different billing account; refusing to replace it.")
    if not current:
        cloud.command("billing", "projects", "link", project, "--billing-account=" + billing)
    cloud.command("services", "enable", *SERVICES, "--project=" + project)
    base = "/v1beta1/projects/" + project
    if cloud.api("firebase.googleapis.com", base, missing=True) is None:
        cloud.operation(cloud.api("firebase.googleapis.com", base + ":addFirebase", "POST", {}))
    apps = cloud.api("firebase.googleapis.com", base + "/webApps").get("apps", [])
    matching = [app for app in apps if app.get("displayName") == "OpenSmash " + domain]
    if len(matching) > 1:
        raise RuntimeError("Multiple OpenSmash Firebase web apps match; choose the intended app explicitly.")
    app = matching[0] if matching else cloud.operation(cloud.api(
        "firebase.googleapis.com", base + "/webApps", "POST", {"displayName": "OpenSmash " + domain}))
    config = cloud.api("firebase.googleapis.com", "/v1beta1/" + app["name"] + "/config")
    auth_path = "/admin/v2/projects/" + project + "/config"
    existing_auth = cloud.api("identitytoolkit.googleapis.com", auth_path, missing=True)
    if existing_auth is None:
        cloud.api("identitytoolkit.googleapis.com", "/v2/projects/" + project + "/identityPlatform:initializeAuth", "POST", {})
        existing_auth = cloud.api("identitytoolkit.googleapis.com", auth_path)
    cloud.api("identitytoolkit.googleapis.com", auth_path + "?" + urlencode({
        "updateMask": "authorizedDomains,signIn.email"}), "PATCH", auth_update(existing_auth, domain))
    # Firebase's reserved /__/auth/* helper is proxied by the website itself.
    hosting = "/v1beta1/projects/" + project + "/sites"
    if cloud.api("firebasehosting.googleapis.com", hosting + "/" + project, missing=True) is None:
        cloud.api("firebasehosting.googleapis.com", hosting + "?" + urlencode({"siteId": project}), "POST", {"appId": app["appId"], "labels": LABELS})
    return {"projectId": project, "siteOrigin": "https://" + domain,
            "firebase": {"apiKey": config["apiKey"], "appId": config["appId"],
                         "authDomain": domain, "providers": ["email"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--billing-account", required=True)
    parser.add_argument("--domain", default="smash.not.fun")
    parser.add_argument("--gcloud", default="gcloud")
    parser.add_argument("--output", type=Path, help="Write public Firebase/site configuration to this new file")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    validate(args.project, args.billing_account, args.domain)
    if not args.apply:
        print(json.dumps({"projectId": args.project, "billingAccount": args.billing_account,
                          "domain": args.domain, "services": SERVICES,
                          "actions": ["create new labeled project (or resume matching project)",
                                      "link billing without replacing a different account", "enable APIs",
                                      "add Firebase web app and email-link authentication",
                                      "authorize website domain and provision Firebase auth helper"]}, indent=2))
        return
    if not args.output or args.output.exists():
        raise ValueError("--apply requires --output pointing to a new file.")
    config = bootstrap(Cloud(args.gcloud, args.project), args.billing_account, args.domain)
    with args.output.open("x") as out:
        os.chmod(args.output, 0o600)
        json.dump(config, out, indent=2)
        out.write("\n")
    print("Project and Firebase prepared; public client configuration saved to", args.output)
    print("Email-link sign-in enabled. Google/Apple sign-in require their provider configuration before being advertised.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
