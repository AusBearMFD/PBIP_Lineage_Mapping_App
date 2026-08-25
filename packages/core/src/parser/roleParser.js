/**
 * Row-Level Security (RLS) role parser.
 *
 * TMDL roles live in their own files and declare no table, e.g.:
 *
 *   role 'Sales Rep'
 *   	modelPermission: read
 *
 *   	tablePermission Sales = 'Sales'[Rep] = USERPRINCIPALNAME()
 *
 *   	tablePermission Region =
 *   			[Allowed Region Flag] > 0
 *
 * The filter expressions are DAX, so they can reference measures and columns.
 * A measure used only by RLS is genuinely in use even though no visual shows
 * it — which is why these references have to reach the lineage graph.
 */

import { extractDaxExpression, unquoteName } from './tmdlParser.js';

/**
 * Parse RLS roles out of role .tmdl files.
 *
 * @param {Array<{path: string, content: string}>} roleFiles
 * @returns {Array<{name: string, modelPermission: string, tablePermissions: Array<{table: string, expression: string}>}>}
 */
export function parseRoles(roleFiles = []) {
  const roles = [];

  for (const { content } of roleFiles) {
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    let current = null;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('///') || trimmed.startsWith('//')) continue;

      const roleMatch = trimmed.match(/^role\s+(.+)$/);
      if (roleMatch) {
        current = {
          name: unquoteName(roleMatch[1].trim()),
          modelPermission: '',
          tablePermissions: [],
        };
        roles.push(current);
        continue;
      }
      if (!current) continue;

      const permMatch = trimmed.match(/^modelPermission\s*:\s*(.+)$/);
      if (permMatch) {
        current.modelPermission = permMatch[1].trim();
        continue;
      }

      // tablePermission <Table> = <DAX>. The DAX may continue on further
      // indented lines, so reuse the same multi-line extractor the measure
      // parser uses.
      const tpMatch = trimmed.match(/^tablePermission\s+(.+?)\s*=\s*(.*)$/);
      if (tpMatch) {
        const table = unquoteName(tpMatch[1].trim());
        const expression = (extractDaxExpression(lines, i) || tpMatch[2] || '').trim();
        current.tablePermissions.push({ table, expression });
      }
    }
  }

  return roles;
}
