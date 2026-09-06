const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { transformSync } = require('/Users/filipkrejca/Documents/trading-journal-aka/node_modules/esbuild');
const source = fs.readFileSync('/Users/filipkrejca/Documents/trading-journal-aka/App.tsx', 'utf8');
// Extract and execute the two production fingerprint functions unchanged.
const lines = source.split('\n').filter(line => /const fingerprint(?:Trades|Simple) =/.test(line)).join('\n');
const compiled = transformSync(`${lines}\nexports.fingerprintTrades=fingerprintTrades; exports.fingerprintSimple=fingerprintSimple;`, {loader:'ts', format:'cjs'}).code;
const exportsObject = {};
vm.runInNewContext(compiled, {exports: exportsObject});
const before = {id: 'trade-1', pnl: 80, timestamp: 1750000000000, notes: 'Old note', quantity: 1};
const after = {...before, notes: 'Corrected from Mac', quantity: 3};
const accountBefore = {id: 'account-1', name: 'Old account name', initialBalance: 50000};
const accountAfter = {...accountBefore, name: 'Updated name', initialBalance: 100000};
assert.equal(exportsObject.fingerprintTrades([before]), exportsObject.fingerprintTrades([after]));
assert.equal(exportsObject.fingerprintSimple([accountBefore]), exportsObject.fingerprintSimple([accountAfter]));
console.log(JSON.stringify({tradeMetadataEditRejected: true, accountContentEditRejected: true, source:'App.tsx production fingerprint functions'}));
