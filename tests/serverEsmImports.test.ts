import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const typescriptFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return extname(entry.name) === '.ts' ? [path] : [];
  });

describe('server Node ESM imports', () => {
  it('cold-loads every emitted API and its transitive runtime imports with the Node resolver', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'alphatrade-api-esm-'));
    const emitted = new Set<string>();
    const emit = (sourcePath: string): string => {
      const outputPath = join(fixture, relative(projectRoot, sourcePath)).replace(/\.[cm]?tsx?$/, '.js');
      if (emitted.has(sourcePath)) return outputPath;
      emitted.add(sourcePath);
      const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
        fileName: sourcePath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText;
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, output);

      // Inspect emitted JS, so type-only imports are removed. Preserve runtime
      // specifiers unchanged: Node must catch missing suffixes in shared lib/.
      const ast = ts.createSourceFile(outputPath, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = (node: ts.Node): void => {
        let specifier: string | undefined;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          specifier = node.arguments[0].text;
        }
        if (specifier?.startsWith('.')) {
          const path = resolve(dirname(sourcePath), specifier);
          const dependency = [path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx'), path, `${path}.ts`, `${path}.tsx`]
            .find(existsSync);
          if (!dependency) throw new Error(`Missing API dependency: ${sourcePath} -> ${specifier}`);
          emit(dependency);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return outputPath;
    };

    try {
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      symlinkSync(realpathSync(join(projectRoot, 'node_modules')), join(fixture, 'node_modules'), 'dir');
      const entries = typescriptFiles(join(projectRoot, 'api')).map(emit);
      const imports = entries.map(path => `await import(${JSON.stringify(pathToFileURL(path).href)});`).join('\n');
      // No handler invocation, credentials, network requests or broker actions.
      // Unlike Vite/Vitest imports, this exercises native Node ESM resolution.
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `${imports}\nconsole.log('API imports ready');`], {
        cwd: fixture,
        encoding: 'utf8',
        // Some API modules initialize SDK clients on import. Use inert values,
        // never the developer's real credentials, and never invoke handlers.
        env: {
          SUPABASE_URL: 'https://example.invalid',
          SUPABASE_ANON_KEY: 'esm-import-test-only',
          SUPABASE_SERVICE_ROLE_KEY: 'esm-import-test-only',
          VAPID_PRIVATE_KEY: Buffer.alloc(32, 1).toString('base64url'),
        },
        timeout: 15_000,
        stdio: 'pipe',
      });
      expect(output.trim()).toBe('API imports ready');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
