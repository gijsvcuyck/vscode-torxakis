const vscode = require('vscode');

function activate(context) {
    const selector = { language: 'torxakis', scheme: 'file' };

    const provider = {
        provideDefinition(document, position, token) {
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
            if (!wordRange) return null;
            const name = document.getText(wordRange);

            const pattern = new RegExp('^\\s*TYPEDEF\\s+' + name + '\\b', 'm');

            // search in current document first
            const txt = document.getText();
            const m = pattern.exec(txt);
            if (m) {
                const idx = m.index;
                const pos = document.positionAt(idx);
                return new vscode.Location(document.uri, pos);
            }

            // search all .txs files in workspace
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
