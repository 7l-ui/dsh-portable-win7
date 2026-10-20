import * as original from 'node:module';
import ts from 'typescript';
export * from 'node:module';
export default original.default;
const PREFIX = 'async function __dsh_program__() {\n';
const SUFFIX = '\n}';

/** Preserve the PTC wrapper that DSH slices by length, while compiling only its TypeScript body. */
export function stripTypeScriptTypes(code, options = {}) {
  if (typeof code !== 'string') throw new TypeError('TypeScript source must be a string.');
  const wrapped = code.startsWith(PREFIX) && code.endsWith(SUFFIX);
  const source = wrapped ? code.slice(PREFIX.length, -SUFFIX.length) : code;
  const result = ts.transpileModule(source, { fileName: options.sourceUrl ?? 'program.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed, sourceMap: Boolean(options.sourceMap), verbatimModuleSyntax: true },
  });
  const error = result.diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
  if (error) throw new SyntaxError(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  // A body containing only type imports can acquire an empty module marker; PTC bodies cannot export.
  const output = wrapped ? result.outputText.replace(/\n?export \{\};\s*$/, '') : result.outputText;
  return wrapped ? `${PREFIX}${output.trimEnd()}${SUFFIX}` : output;
}
