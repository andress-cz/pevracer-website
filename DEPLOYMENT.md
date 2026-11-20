# Deploying the PEV Racer website

The website source lives in this workspace at `sites/pevracer/dist/`. The public site is a separate repository, `andress-cz/pevracer-website`, deployed by its GitHub Pages workflow from the root of `main`.

## Publish the current website

Run these commands from the Android app workspace root:

```sh
git clone https://github.com/andress-cz/pevracer-website.git /tmp/pevracer-website
rsync -rc sites/pevracer/dist/ /tmp/pevracer-website/
```

If `/tmp/pevracer-website` already exists, update it first:

```sh
git -C /tmp/pevracer-website pull --ff-only
rsync -rc sites/pevracer/dist/ /tmp/pevracer-website/
```

Review the staged website files and preserve the existing `CNAME` file:

```sh
git -C /tmp/pevracer-website status --short
git -C /tmp/pevracer-website add --all
git -C /tmp/pevracer-website diff --cached --check
git -C /tmp/pevracer-website diff --cached --stat
```

Commit and push the reviewed update:

```sh
git -C /tmp/pevracer-website commit -m "Describe the website update"
git -C /tmp/pevracer-website push origin main
gh run list --repo andress-cz/pevracer-website --limit 3
```

Use the newest Pages workflow run ID from `gh run list` and wait for it to finish:

```sh
gh run watch RUN_ID --repo andress-cz/pevracer-website --exit-status
```

Then open [pevracer.com](https://pevracer.com/) and the changed page. Check that the expected change appears.

## Important details

- Run Git commands against the public website checkout. The Android app repository has a different remote and does not deploy the website.
- Keep the domain file `CNAME` in the public repository root. The `rsync -rc` command copies source files and leaves deployment-repository-only files such as `CNAME` in place.
- Do not use `rsync --delete`. Public site files that should be removed must be explicitly removed from the deployment repository and committed.
- The root website and rider dashboard are static files. GitHub Actions publishes them to GitHub Pages after changes land on `main`.
- Website source changes should be made in `sites/pevracer/dist/`, then copied to the public repository before deploying.
