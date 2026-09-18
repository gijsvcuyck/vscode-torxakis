const vscode = require('vscode');

function activate(context) {
    const selector = { language: 'torxakis', scheme: 'file' };

    // In-memory index: symbolName -> Array<vscode.Location>
    const index = new Map();
    // Reverse map: fileUri -> Set<symbolName>
    const fileSymbols = new Map();

    function addToIndex(name, location) {
        const arr = index.get(name) || [];
        arr.push(location);
        index.set(name, arr);
    }

    function removeFileFromIndex(uriStr) {
        const names = fileSymbols.get(uriStr);
        if (names) {
            for (const n of names) {
                const arr = index.get(n);
                if (arr) {
                    const filtered = arr.filter(l => l.uri.toString() !== uriStr);
                    if (filtered.length) index.set(n, filtered); else index.delete(n);
                }
            }
            fileSymbols.delete(uriStr);
        }
    }

    async function indexDocument(doc) {
        try {
            const txt = doc.getText();
            const regex = /^\s*TYPEDEF\s+([A-Za-z0-9_]+)/gm;
            let m;
            const names = new Set();
            while ((m = regex.exec(txt)) !== null) {
                const name = m[1];
                const idx = m.index;
                const pos = doc.positionAt(idx);
                const loc = new vscode.Location(doc.uri, pos);
                addToIndex(name, loc);
                names.add(name);
            }
            fileSymbols.set(doc.uri.toString(), names);
        } catch (e) {
            // ignore
        }
    }

    async function buildIndex() {
        index.clear();
        fileSymbols.clear();
        const uris = await vscode.workspace.findFiles('**/*.txs');
        await Promise.all(uris.map(async uri => {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await indexDocument(doc);
            } catch (e) {
                // ignore
            }
        }));
    }

    // Initial index build (async)
    buildIndex();

    // Update a single document's entry
    async function updateDocument(doc) {
        const uriStr = doc.uri.toString();
        removeFileFromIndex(uriStr);
        await indexDocument(doc);
    }

    // File system watcher to track external changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.txs');
    watcher.onDidCreate(uri => {
        vscode.workspace.openTextDocument(uri).then(doc => updateDocument(doc));
    });
    watcher.onDidChange(uri => {
        vscode.workspace.openTextDocument(uri).then(doc => updateDocument(doc));
    });
    watcher.onDidDelete(uri => {
        removeFileFromIndex(uri.toString());
    });
    context.subscriptions.push(watcher);

    // Update index when editors change/save
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId === 'torxakis') updateDocument(doc);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'torxakis') updateDocument(doc);
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
        // keep index entries (optional); remove to free memory
        // removeFileFromIndex(doc.uri.toString());
    }));

    const provider = {
        provideDefinition(document, position, token) {
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
            if (!wordRange) return null;
            const name = document.getText(wordRange);

            // Prefer indexed results
            const results = index.get(name);
            if (results && results.length) {
                // If the declaration is in the same file and before current position, prefer it first
                const sorted = results.slice().sort((a, b) => {
                    if (a.uri.toString() === document.uri.toString() && b.uri.toString() !== document.uri.toString()) return -1;
                    if (b.uri.toString() === document.uri.toString() && a.uri.toString() !== document.uri.toString()) return 1;
                    return a.range.start.compareTo(b.range.start);
                });
                return sorted;
            }

            // Fallback: scan current document synchronously
            const pattern = new RegExp('^\\s*TYPEDEF\\s+' + name + '\\b', 'm');
            const txt = document.getText();
            const m = pattern.exec(txt);
            if (m) {
                const idx = m.index;
                const pos = document.positionAt(idx);
                return new vscode.Location(document.uri, pos);
            }

            // As last resort, scan workspace (slow)
            return vscode.workspace.findFiles('**/*.txs').then(uris => {
                const opens = uris.map(uri => vscode.workspace.openTextDocument(uri).then(doc => {
                    const t = doc.getText();
                    const mm = pattern.exec(t);
                    if (mm) {
                        const i = mm.index;
                        const p = doc.positionAt(i);
                        return new vscode.Location(doc.uri, p);
                    }
                    return null;
                }));
                return Promise.all(opens).then(results => results.find(r => r) || null);
            });
        }
    };

    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, provider));
}

function deactivate() {}

module.exports = { activate, deactivate };
