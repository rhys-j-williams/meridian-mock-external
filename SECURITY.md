# Application security standard — External system mocks

Owner: @meridian/platform-engineering. Standard reference: GIS-STD-014 Application Security Requirements for Internet
Facing and Internal Digital Channels, revision 9, effective 1 February 2026.

## Reporting

Suspected vulnerabilities go to the Global Information Security intake queue
(`gis-appsec-intake@meridian.internal`) with the component name `mock-external` and, if the finding came
from a scan, the Checkmarx or Xray report identifier. Do not raise a public issue and do not
attach exploit payloads to a Jira ticket.

## Requirements this component is assessed against

1. **Authentication and session.** All authenticated surfaces obtain tokens from Keystone using
   OpenID Connect authorization code with PKCE. Tokens are never written to `localStorage` or to a
   cookie without `HttpOnly`. Idle timeout warns at 8 minutes and terminates at 10.
2. **Step up.** Money movement above the configured threshold requires an MFA claim no older than
   ten minutes (`mfa_at`). Step up is enforced server side; the front end guard is a convenience,
   not a control.
3. **Transport.** TLS 1.2 minimum. Certificate validation is never disabled, in code or in build
   configuration.
4. **Output encoding.** Angular's default sanitisation must not be bypassed. Any use of
   `bypassSecurityTrust*` requires a documented GIS exception with an expiry date.
5. **Cross site request forgery.** State changing calls carry the `X-MERIDIAN-XSRF` header sourced
   from the `MERIDIAN-XSRF` cookie.
6. **Content Security Policy.** No `unsafe-inline` for scripts. Vendor origins are allow-listed
   individually and reviewed at each release train.
7. **Secrets.** No credentials in source, configuration, fixtures or pipeline definitions. Runtime
   secrets are rendered by the Vault agent into the container environment. Placeholders in this
   estate take the form `CHANGEME-<purpose>`.
8. **Dependencies.** Only the internal registry may be used, see DEPENDENCY_POLICY.md in
   platform-tooling. High severity advisories block the release train.
9. **Logging.** No PII, card numbers, full account numbers or tokens in logs. Account numbers are
   masked to the last four digits. Every log line carries `correlationId`.
10. **Accessibility as a control.** WCAG 2.1 AA is contractual for consumer surfaces. Accessibility
    defects on authentication or money movement paths are treated as production incidents.

## Scanning

Checkmarx (`checkmarx.yml`) and SonarQube (`sonar-project.properties`) run in the Jenkins pipeline
for every pull request. The quality gate fails the build on any high severity finding and on a
coverage drop of more than two points against the branch baseline.
