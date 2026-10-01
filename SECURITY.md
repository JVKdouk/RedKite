# Security

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/JVKdouk/RedKite/security/advisories/new),
or by email to contato@kdouk.com. Please do not open a public issue for
anything that affects a running deployment.

Expect an acknowledgement within a few days. If a fix needs a release, the
advisory is published with it rather than before it.

## What is supported

The latest published version. While this is `0.x` there is no backport branch,
so a fix goes out as a new release and upgrading is the way to get it.

## What redkite handles

Worth knowing when you are judging whether something is a vulnerability or the
documented behaviour.

**Secret values never appear in a command line.** An app's environment is written
to a file and passed as `--env-file`, and a build secret is a BuildKit
`--secret` mount. Neither is in any `argv` that `--verbose` or a crash log can
print. A secret value reaching a log is a bug worth reporting.

**The deploy scratch directory is created `mkdir -p -m 700`** and removed when
the connection closes. The environment files inside it are readable for the
length of the deploy by whoever owns that directory, and by root.

**Crash logs are written under `/tmp`** with mode `0700` on the directory and
`0600` on each file. They hold everything the run said, which includes whatever
your build printed. A build that echoes a secret puts it there.

**The fingerprint names secrets, it does not read them.** `plan` answers whether
a running service matches the config without unlocking a vault, so a changed ref
counts and a rotated value does not.

**`hostKeys` defaults to `accept-new`**, which trusts a deploy host the first
time it is seen. On a CI runner `known_hosts` is empty every run, so that is
first sight every time. `hostKeys: "strict"` plus a key written into
`~/.ssh/known_hosts` before the deploy step is what makes it an actual check.

**Redkite runs what your config tells it to run**, on the host it names, as the
user it connects as. A `redkite.config.ts` is executed, not parsed: it is code,
and it deserves the review any other code in the repository gets.
