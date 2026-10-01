## What this changes

<!-- The behaviour, not the diff. What a deployment does differently afterwards. -->

## What holds it in place

<!--
Which test fails without this change. CONTRIBUTING.md has the convention the
suite is written to: revert the behaviour and check a test actually fails,
because a test that passes either way holds nothing.

If something here is not covered, say which part and why. "plan writes straight
to stdout" is a reason. Leaving it blank is not.
-->

## Checklist

- [ ] `npm run check` and `npm test` pass
- [ ] Anything a config can now say is documented in `README.md`
- [ ] A user-facing change has an entry under Unreleased in `CHANGELOG.md`
- [ ] `PIPELINE` in `build.ts` is bumped if the build changed shape without any
      config changing, since it is part of the image tag and a host that trusts
      the commit alone keeps serving the previous pipeline's output
