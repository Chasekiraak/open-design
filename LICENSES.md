# Repository licensing map

This file explains the licensing boundary in the Open Design repository. It
does not replace the license or attribution notice attached to a file or
component.

## Current root license

First-party material expressly distributed with the root [`LICENSE`](LICENSE)
is offered under the Open Design Community License 1.0, but only to the extent
that its applicable licensor owns the relevant rights or is authorized to
grant them. The root license is a custom source-available license; it is not
the unmodified Apache License 2.0 and is not an OSI-approved open-source
license.

The root license governs only the public material distributed from this
repository. It does not grant access to the separately developed private Team
backend, Open Design Cloud, hosted accounts, billing systems, model capacity,
or other private services; those are governed by separate service terms. The
root license does not require a Team subscription merely because multiple
people use a customer-operated copy of the public software.

A third party requires separate commercial authorization before continuously
operating Open Design for any external customer, embedding it in another
product or service, or offering it through OEM, resale, sublicensing, or white
labeling. Customer-operated deployments, delivery of completed outputs, and
independently written API integrations remain
allowed within the boundaries stated in the root license.

## Historical Apache-licensed material

The specific tagged release `open-design-v0.15.1` and repository revision
`581a938a0edb0406b29424354df819479bae6d35` are confirmed historical examples
that may be used under the canonical Apache License 2.0 to the extent the
Project Steward owns or is authorized to license the relevant rights. This is
not an exhaustive cutoff: every other copy actually distributed under Apache
License 2.0 remains governed by that license whether or not listed here.

Those historical releases, commits, files, and copies remain available under
their original terms and, subject to the rights boundary above, the canonical
Apache License 2.0. The new root license does not revoke or narrow rights
already granted for them. A current distribution can therefore contain both
new material offered under the root license and material for which recipients
also retain rights from an earlier Apache-licensed copy.

When evaluating a particular file or portion, consult its history and the
license that accompanied the copy you received. Do not assume that replacing
the root license retroactively relicensed earlier contributions.

## Separately licensed and third-party material

A file or component with its own license or attribution notice remains under
that notice. This includes bundled skills, templates, fonts, images, media,
datasets, design systems, and dependencies. Representative separately licensed
components include:

- `design-templates/guizang-ppt/` — MIT
- `design-templates/html-ppt/` — MIT
- `skills/web-clone/` — MIT
- HyperFrames-derived material that carries Apache-2.0 notices

Redistributors must keep those component notices and any applicable `NOTICE`
files intact.

## Contributions after the change

Contributions to root-licensed files are accepted only after the contributor
affirmatively agrees to additional condition 2 of the root license in a durable written
record, normally the required pull-request checkbox. Components with their own
license continue to follow that component's contribution terms.

Licensing questions and requests for a commercial exception can be sent to
<support@open-design.ai>.
