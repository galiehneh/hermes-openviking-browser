# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Include the plugin version, steps to reproduce and the impact you see.

You can expect an acknowledgement within a few days. Fixes are released as soon as practical and
credited to the reporter unless you prefer otherwise.

## Scope

In scope: anything that lets a dashboard user reach a non-whitelisted OpenViking operation, escape the
`viking://` URI validation, or obtain the server-side API key. Out of scope: vulnerabilities in Hermes
Agent or OpenViking themselves (report those upstream).

If you ever pasted a real API key into an issue or a pull request, rotate it immediately.
