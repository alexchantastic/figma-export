# Publishing Figma Files Sync

## First publication and trust setup

The package must already exist on npm before its Trusted Publisher can be configured. Choose one bootstrap path explicitly:

- Publish the reviewed **1.0.0** manually; start OIDC releases with the next version.
- To publish **1.0.0 via CI**, first publish a real prerelease (for example **0.0.0-bootstrap**, dist-tag **bootstrap**), then register the Trusted Publisher and push the stable tag. The prerelease remains public history; do not create an empty placeholder or silently change the main package version for this step.

No bootstrap package is published automatically by this repository.

For a manual publish of the current package:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public
```

Complete browser / 2FA prompts locally. Never share tokens or put them in this repository. The prepublish hook runs checks and an isolated production-install/npx smoke test.

## Configure npm Trusted Publisher

After package creation, open the package settings on npmjs.com and add a **GitHub Actions** Trusted Publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization or user | victorwads |
| Repository | figma-files-sync |
| Workflow filename | publish.yml |
| Environment name | npm |
| Allowed actions | Enable direct publishing with npm publish |

Enter the workflow filename only, not its full path. Stage-only permission does not permit this workflow's direct publish operation. The file must first exist on GitHub.

In GitHub Settings → Environments, create **npm** and configure appropriate reviewers and version-tag deployment protections. It must match the npm trust configuration. A newly created trust must perform its first successful publish within npm's validity window (currently two days).

After a successful OIDC publish, prefer npm's **Require two-factor authentication and disallow tokens** publishing-access setting. Do not create NPM_TOKEN or NODE_AUTH_TOKEN GitHub secrets for this workflow.

## Release through CI

1. Update the version in package.json and lockfile. The CLI reads the installed package version automatically.
2. Run:

```sh
npm run check
npm run format:check
npm run test:package
```

3. Commit and push the reviewed release on main.
4. Create and push a matching stable version tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Use a new version if 1.0.0 was already published during bootstrap. npm versions are immutable.

The workflow checks that the stable tag matches package.json and belongs to main. It uses a GitHub-hosted Node 24 runner with npm 11 (trusted publishing requires npm >=11.5.1), job-scoped id-token permission and the npm environment. It tests the package, publishes a verified tarball with provenance, and checks public installation through npm exec/npx.

Manual workflow_dispatch is available when selecting an existing version tag, not a branch. The publication job runs only for victorwads/figma-files-sync, never pull requests. It does not cache release dependencies and does not generate an npmrc token placeholder.

## Recovery

- E401 / ENEEDAUTH locally: renew npm login. npm authentication is separate from Figma authentication.
- E404 / ENEEDAUTH in CI: check package existence, repository/workflow/environment match, direct-publish permission and npm version.
- If publishing succeeded but registry verification failed, do not republish the same version. Verify public registry state first; rerunning the complete workflow would attempt an immutable version again.
- Public tests do not use Figma credentials. Native UI downloads still require a separate authorized smoke test.

References: [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/) and [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
