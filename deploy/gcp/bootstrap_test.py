import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("opensmash_bootstrap", Path(__file__).with_name("bootstrap.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class FakeCloud:
    project = "opensmash-test"

    def __init__(self, labels=b.LABELS, billing="billingAccounts/012ABC-345DEF-678ABC"):
        self.labels = labels
        self.billing = billing
        self.commands = []
        self.mutations = []

    def command(self, *args):
        self.commands.append(args)
        if args[:2] == ("projects", "list"):
            return [{"projectId": self.project, "labels": self.labels}]
        if args[:3] == ("billing", "projects", "describe"):
            return {"billingAccountName": self.billing}
        if args[:2] == ("services", "enable"):
            return None
        raise AssertionError("Unexpected mutation: " + repr(args))

    def api(self, host, path, method="GET", body=None, missing=False):
        if method != "GET":
            self.mutations.append((host, path, method, body))
            return {}
        if path.endswith("/webApps"):
            return {"apps": [{"name": "projects/opensmash-test/webApps/1:test:web:app", "appId": "1:test:web:app", "displayName": "OpenSmash smash.not.fun"}]}
        if "/webApps/" in path and path.endswith("/config"):
            return {"apiKey": "public-client-key", "appId": "1:test:web:app"}
        if host == "identitytoolkit.googleapis.com":
            return {"authorizedDomains": ["opensmash-test.firebaseapp.com", "existing.example"], "mfa": {"state": "ENABLED"}}
        return {}


class BootstrapTests(unittest.TestCase):
    def test_rejects_unowned_project_before_billing_or_api_mutation(self):
        cloud = FakeCloud(labels={})
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            b.bootstrap(cloud, "012ABC-345DEF-678ABC", "smash.not.fun")
        self.assertEqual(len(cloud.commands), 1)
        self.assertEqual(cloud.mutations, [])

    def test_refuses_replacing_an_existing_billing_account(self):
        cloud = FakeCloud(billing="billingAccounts/AAAAAA-BBBBBB-CCCCCC")
        with self.assertRaisesRegex(RuntimeError, "different billing account"):
            b.bootstrap(cloud, "012ABC-345DEF-678ABC", "smash.not.fun")
        self.assertEqual(len(cloud.commands), 2)
        self.assertEqual(cloud.mutations, [])

    def test_resume_retains_existing_auth_domains_and_unrelated_settings(self):
        cloud = FakeCloud()
        config = b.bootstrap(cloud, "012ABC-345DEF-678ABC", "smash.not.fun")
        self.assertEqual(config["firebase"]["providers"], ["email"])
        self.assertEqual(config["firebase"]["authDomain"], "smash.not.fun")
        self.assertEqual(len(cloud.mutations), 1)
        host, path, method, body = cloud.mutations[0]
        self.assertEqual(host, "identitytoolkit.googleapis.com")
        self.assertEqual(method, "PATCH")
        self.assertIn("updateMask=authorizedDomains%2CsignIn.email", path)
        self.assertEqual(body["authorizedDomains"], ["existing.example", "opensmash-test.firebaseapp.com", "smash.not.fun"])
        self.assertNotIn("mfa", body)
        self.assertFalse(any(command[:2] == ("projects", "create") for command in cloud.commands))

    def test_validation_rejects_paths_credentials_and_argument_injection(self):
        for project, billing, domain in [
            ("--other-project", "012ABC-345DEF-678ABC", "smash.not.fun"),
            ("opensmash-test", "--account=attacker", "smash.not.fun"),
            ("opensmash-test", "012ABC-345DEF-678ABC", "https://smash.not.fun"),
            ("opensmash-test", "012ABC-345DEF-678ABC", "smash.not.fun/path"),
            ("opensmash-test", "012ABC-345DEF-678ABC", "bad..example"),
            ("opensmash-test", "012ABC-345DEF-678ABC", "bad.-label.example"),
        ]:
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                b.validate(project, billing, domain)
        b.validate("opensmash-test", "012ABC-345DEF-678ABC", "smash.not.fun")


if __name__ == "__main__":
    unittest.main()
