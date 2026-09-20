# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting instead:

<https://github.com/wxxb789/anc/security/advisories/new>

Include the affected version or commit, the smallest reproduction you can make,
and the impact you believe it has. You will get an acknowledgement and an update
as the report is triaged.

## Scope

ANC builds a static site from Markdown and ships a browser Worker that reads a
public SQLite snapshot. Two boundaries are in scope:

- **Publication.** A withheld note's body, title, excerpt, or its authored path
  reaching the generated output, or a release gate that can be satisfied without
  the committed publish set it requires.
- **The browser boundary.** A snapshot, asset, or the Worker escaping the
  read-only, same-origin model, including injection through note content.

Deployment and hosting are the operator's responsibility and are out of scope
here. So is a misconfigured `publish.config.yaml`: default-publish is documented
behavior, and its failure modes are the subject of the build's own gates rather
than vulnerabilities.
