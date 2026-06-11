# Commands Log

A running list of the terminal commands we use on this project, with a one-line note each.
For study — read top to bottom. Newest sections added as we go.

## Local preview (run a copy of the site on your own computer)

```powershell
python -m http.server 8000
# Starts Python's built-in web server in the current folder, on port 8000.
# View the site at http://localhost:8000  ("localhost" = this computer only, not the internet)
# Leave it running while you work; press Ctrl+C in its window to stop it.

curl -s -o nul -w "%{http_code}" http://localhost:8000
# Quick health check: asks the server for the page and prints just the status code.
# 200 means "OK, it's working".  -s = silent,  -o nul = throw away the page body.
```

## Git (publishing to the live site — pushing to `main` goes straight to anilprojects.com)

```bash
git status --short
# Lists changed files. " M" = modified, "??" = new/untracked. A quick "what's changed?".

git diff --stat -- index.html script.js style.css
# Summary of how many lines changed in each file (no full text). A safe preview.

git add index.html style.css script.js COMMANDS-LOG.md
# Stages ONLY these files for the next commit (on purpose — keeps stray .tmp files out).

git commit -m "Your message here"
# Saves the staged files as one labelled snapshot in your project's history (still local).

git push origin main
# Sends the commit to GitHub. This is the step that PUBLISHES to the live site.
```

## Fixing a stuck GitHub Pages deploy

```bash
touch .nojekyll
# Creates an empty file named .nojekyll. It tells GitHub Pages: "serve my files as-is,
# don't run the Jekyll build step." Good for a plain HTML/CSS/JS site like this one.
# Committing + pushing this also triggers a fresh build, which can unstick a stuck deploy.
```

