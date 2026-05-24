# Contributing

Thanks for considering a contribution to Profile Manager.

## Development setup

```powershell
npm install
npm run lint
npm run build
```

## Pull requests

- Keep changes focused and describe the behavior being changed.
- Run `npm run lint` and `npm run build` before opening a pull request.
- Do not include local vault paths, private screenshots, credentials, or generated `main.js` changes in source commits.
- For UI text, follow Obsidian's sentence-case guidance.

## Release assets

GitHub releases should attach:

- `main.js`
- `manifest.json`
- `styles.css`
