const vscode = require('vscode');

function activate(context) {
    const selector = { language: 'torxakis', scheme: 'file' };

    // In-memory index: symbolName -> Array<{ kind: string, location: vscode.Location }>
    const index = new Map();
    // Reverse map: fileUri -> Set<symbolName>
    const fileSymbols = new Map();

    function addToIndex(name, location, kind, meta) {
        const arr = index.get(name) || [];
        arr.push({ kind, location, meta });
        index.set(name, arr);
    }

    function removeFileFromIndex(uriStr) {
        const names = fileSymbols.get(uriStr);
        if (names) {
            for (const n of names) {
                const arr = index.get(n);
                if (arr) {
                    const filtered = arr.filter(e => e.location.uri.toString() !== uriStr);
                    if (filtered.length) index.set(n, filtered); else index.delete(n);
                }
            }
            fileSymbols.delete(uriStr);
        }
    }

    async function indexDocument(doc) {
        try {
            // Remove any existing entries for this document to avoid duplicates
            removeFileFromIndex(doc.uri.toString());
            const txt = doc.getText();
            const regex = /^\s*(TYPEDEF|PROCDEF|MODELDEF)\s+([A-Za-z0-9_]+)/gm;
            let m;
            const names = new Set();
            while ((m = regex.exec(txt)) !== null) {
                const kind = m[1];
                const name = m[2];
                const idx = m.index;
                const pos = doc.positionAt(idx);
                const loc = new vscode.Location(doc.uri, pos);
                addToIndex(name, loc, kind, null);
                names.add(name);

                // If this is a TYPEDEF, also index its constructors and implicit isX functions
                if (kind === 'TYPEDEF') {
                    // find ENDDEF after this typedef
                    const startPos = m.index;
                    const endMarker = 'ENDDEF';
                    const endIdx = txt.indexOf(endMarker, startPos);
                    const block = endIdx !== -1 ? txt.slice(startPos, endIdx) : txt.slice(startPos);
                    const assignIdx = block.indexOf('::=');
                    if (assignIdx !== -1) {
                        const ctorBlock = block.slice(assignIdx + 3);
                        const ctorRegex = /^\s*(?:\|)?\s*([A-Za-z0-9_]+)(?=\s|\||\{|$)/gm;
                        let cm;
                        while ((cm = ctorRegex.exec(ctorBlock)) !== null) {
                            const ctorName = cm[1];
                            const ctorOffset = startPos + assignIdx + 3 + cm.index;
                            const ctorPos = doc.positionAt(ctorOffset);
                            const ctorLoc = new vscode.Location(doc.uri, ctorPos);
                            addToIndex(ctorName, ctorLoc, 'CONSTRUCTOR', { parent: name });
                            names.add(ctorName);

                            // implicit isXXX function
                            const isName = 'is' + ctorName;
                            addToIndex(isName, ctorLoc, 'IS_CONSTRUCTOR', { parent: name });
                            names.add(isName);
                        }
                    }
                }

                // If this is a PROCDEF or MODELDEF, extract channel params and their types, and index them as CHANNEL
                if (kind === 'PROCDEF' || kind === 'MODELDEF') {
                    // find bracketed params list starting after the name
                    const afterName = txt.slice(idx + name.length);
                    const openBracket = afterName.indexOf('[');
                    if (openBracket !== -1) {
                        const absOpen = idx + name.length + openBracket;
                        const closeBracket = txt.indexOf(']', absOpen + 1);
                        if (closeBracket !== -1) {
                            const header = txt.slice(absOpen + 1, closeBracket);
                            // parse entries like "ChanName :: Type"
                            const chanRegex = /([A-Za-z0-9_]+)\s*::\s*([^;]+)/gm;
                            let chm;
                            while ((chm = chanRegex.exec(header)) !== null) {
                                const chanName = chm[1];
                                const chanType = chm[2].trim();
                                // scope is from idx to endIdx (ENDDEF) if present
                                const scopeStart = idx;
                                const endMarker = 'ENDDEF';
                                const endIdx = txt.indexOf(endMarker, idx);
                                const scopeEnd = endIdx !== -1 ? endIdx + endMarker.length : txt.length;
                                // location: point at the start of the header where channel is declared
                                const chanOffset = absOpen + 1 + chm.index;
                                const chanPos = doc.positionAt(chanOffset);
                                const chanLoc = new vscode.Location(doc.uri, chanPos);
                                addToIndex(chanName, chanLoc, 'CHANNEL', { scopeStart, scopeEnd, type: chanType });
                                names.add(chanName);
                            }
                        }
                    }
                }
            }
            fileSymbols.set(doc.uri.toString(), names);
        } catch (e) {
            // ignore
        }
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
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
                // Determine whether this occurrence is a call: immediately followed by optional whitespace and '('
                const afterOffset = document.offsetAt(wordRange.end);
                const rest = document.getText().slice(afterOffset);
                const callContext = /^\s*\(/.test(rest);

                // Filter out constructor/indexed is-functions when NOT in a call context
                let candidates = results.filter(r => {
                    if (callContext) return true;
                    return r.kind !== 'CONSTRUCTOR' && r.kind !== 'IS_CONSTRUCTOR';
                });

                // Further filter CHANNEL candidates by scope: channel must be declared in a containing PROCDEF/MODELDEF
                const currentOffset = document.offsetAt(position);
                candidates = candidates.filter(r => {
                    if (r.kind === 'CHANNEL') {
                        if (r.location.uri.toString() !== document.uri.toString()) return false;
                        const meta = r.meta || {};
                        return (typeof meta.scopeStart === 'number' && typeof meta.scopeEnd === 'number') ? (meta.scopeStart <= currentOffset && currentOffset < meta.scopeEnd) : false;
                    }
                    return true;
                });

                if (!candidates.length) {
                    // No applicable indexed definitions for this context
                    return null;
                }

                if (candidates.length === 1) return candidates[0].location;

                // Prepare quick pick items for disambiguation
                // Prefer entries in the same file, then by position
                candidates.sort((a, b) => {
                    const aSame = a.location.uri.toString() === document.uri.toString();
                    const bSame = b.location.uri.toString() === document.uri.toString();
                    if (aSame && !bSame) return -1;
                    if (bSame && !aSame) return 1;
                    return a.location.range.start.line - b.location.range.start.line;
                });

                const items = candidates.map(r => {
                    const loc = r.location;
                    return {
                        label: `${r.kind} ${name}`,
                        description: `${vscode.workspace.asRelativePath(loc.uri)}:${loc.range.start.line + 1}`,
                        entry: r
                    };
                });

                const pick = vscode.window.showQuickPick(items, { placeHolder: 'Multiple definitions found — select one' });
                return Promise.resolve(pick && pick.then ? pick.then(p => p ? p.entry.location : candidates.map(r => r.location)) : null).then(res => {
                    if (!res) return candidates.map(r => r.location);
                    if (res && res.location) return res.location;
                    return res;
                });
            }

            // Fallback: scan current document synchronously
            const safeName = escapeRegExp(name);
            const pattern = new RegExp('^\\s*(?:TYPEDEF|PROCDEF|MODELDEF)\\s+' + safeName + '\\b', 'm');
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

    // Hover provider for channel types
    const hoverProvider = {
        provideHover(document, position, token) {
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
            if (!wordRange) return null;
            const name = document.getText(wordRange);
            const entries = index.get(name);
            if (!entries || !entries.length) return null;
            const offset = document.offsetAt(position);
            // find CHANNEL entry in-scope
            for (const e of entries) {
                if (e.kind === 'CHANNEL' && e.location.uri.toString() === document.uri.toString()) {
                    const meta = e.meta || {};
                    if (typeof meta.scopeStart === 'number' && typeof meta.scopeEnd === 'number' && meta.scopeStart <= offset && offset < meta.scopeEnd) {
                        const md = new vscode.MarkdownString();
                        md.appendMarkdown(`**Channel** \`${name}\` — type: \`${meta.type}\``);
                        return new vscode.Hover(md, wordRange);
                    }
                }
            }
            return null;
        }
    };
    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, hoverProvider));
}

function deactivate() {}

module.exports = { activate, deactivate };
