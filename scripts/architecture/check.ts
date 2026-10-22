/**
 * Architecture check: enforces the layer rules from the Platform Architecture Plan (V3.1).
 *
 * Rules (each is switched on by architecture.config.json at the repo root):
 *   1. sdkGroups        – provider and identity SDKs may be imported or depended on only under allowed paths.
 *   2. workspaceDeps    – which workspace packages each package may depend on (module isolation,
 *                         libraries never depend on apps).
 *   3. forbiddenPackages – packages from other layers this repo must never depend on
 *                         (the hub depends on neither platform-core nor apps).
 *   4. permissionChecks – code checks permission keys, never role names or user IDs.
 *   5. turboRequired    – turbo.json present and every workspace package has build/test wiring.
 *
 * Exit code 1 on any violation. Run: node --experimental-strip-types scripts/architecture/check.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SdkGroup {
  name: string;
  packages: string[];
  allowedPaths: string[];
}

export interface ArchitectureConfig {
  /**
   * Groups of banned SDKs, each with the only paths allowed to use them.
   * Package entries: exact name ('stripe'), whole scope ending in '/' ('@sendgrid/'),
   * or name prefix ending in '*' ('@aws-sdk/client-ses*' covers client-ses and client-sesv2).
   * allowedPaths: path prefixes relative to the repo root, '/'-separated.
   */
  sdkGroups: SdkGroup[];
  /** Workspace packages any library may depend on, by default. */
  baseAllowedDeps?: Record<string, string[]>;
  /** Default allow-list for packages not named in baseAllowedDeps ("modules"). */
  moduleAllowedDeps?: string[];
  /** Package-name prefixes that must never appear as dependencies anywhere in this repo. */
  forbiddenPackages?: string[];
  /** External packages from other layers that are allowed (e.g. '@platform-core/sdk'). */
  allowedExternalLayerPackages?: string[];
  permissionChecks?: boolean;
  turboRequired?: boolean;
}

export interface Violation {
  rule: 'provider-sdk' | 'workspace-deps' | 'forbidden-package' | 'permission-check' | 'turbo';
  file: string;
  line?: number;
  message: string;
}

interface WorkspacePackage {
  name: string;
  dir: string; // relative, '/'-separated
  kind: 'library' | 'app';
  deps: string[];
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', '.next', 'coverage', '.tmp-dist']);
const IMPORT_RE =
  /(?:^|[^\w.$])(?:import\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|export\s+(?:type\s+)?[\w*{}\s,$]+\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

const PERMISSION_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(?:role|roleName|role_name|roleKey)\s*(?:===|!==|==|!=)\s*['"`]/, why: 'compares a role name' },
  { re: /['"`][\w-]+['"`]\s*(?:===|!==|==|!=)\s*\w*\.?(?:role|roleName|role_name)\b/, why: 'compares a role name' },
  { re: /\.hasRole\s*\(/, why: 'calls hasRole(); check a permission key instead' },
  { re: /\broles?\.includes\s*\(\s*['"`]/, why: 'checks membership of a named role' },
  { re: /\b(?:userId|user_id|personId|person_id)\s*(?:===|==)\s*['"`][\w-]{6,}['"`]/, why: 'special-cases a user ID' },
];

const toPosix = (p: string) => p.split(sep).join('/');

export function loadConfig(root: string): ArchitectureConfig {
  const file = join(root, 'architecture.config.json');
  if (!existsSync(file)) throw new Error(`architecture.config.json not found in ${root}`);
  return JSON.parse(readFileSync(file, 'utf8')) as ArchitectureConfig;
}

function listWorkspaceDirs(root: string): string[] {
  const out: string[] = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) out.push(dir);
    }
  }
  return out;
}

export function readWorkspace(root: string): WorkspacePackage[] {
  return listWorkspaceDirs(root).map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const rel = toPosix(relative(root, dir));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    return { name: pkg.name as string, dir: rel, kind: rel.startsWith('apps/') ? 'app' : 'library', deps };
  });
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(entry)) yield full;
  }
}

function matchSdk(spec: string, sdks: string[]): string | undefined {
  // Normalise deep imports: 'stripe/lib/x' -> 'stripe', '@scope/pkg/x' -> '@scope/pkg'
  const parts = spec.split('/');
  const base = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return sdks.find((s) => {
    if (s.endsWith('/')) return base.startsWith(s); // whole scope, e.g. '@sendgrid/'
    if (s.endsWith('*')) return base.startsWith(s.slice(0, -1)); // name prefix, e.g. '@aws-sdk/client-ses*'
    return base === s;
  });
}

const isAllowedPath = (rel: string, allowed: string[] = []) =>
  allowed.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`));

/** Returns the group that bans this specifier at this path, or undefined if it is allowed. */
function bannedBy(spec: string, rel: string, groups: SdkGroup[]): SdkGroup | undefined {
  return groups.find((g) => matchSdk(spec, g.packages) !== undefined && !isAllowedPath(rel, g.allowedPaths));
}

const describeAllowed = (g: SdkGroup) => (g.allowedPaths.length ? g.allowedPaths.join(', ') : 'nowhere in this repo');

const isTestFile = (rel: string) => /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

export function check(root: string, config: ArchitectureConfig = loadConfig(root)): Violation[] {
  const violations: Violation[] = [];
  const workspace = readWorkspace(root);
  const workspaceNames = new Set(workspace.map((p) => p.name));
  const byName = new Map(workspace.map((p) => [p.name, p]));

  // 5. Turbo wiring
  if (config.turboRequired) {
    if (!existsSync(join(root, 'turbo.json'))) {
      violations.push({ rule: 'turbo', file: 'turbo.json', message: 'turbo.json is missing' });
    }
    for (const p of workspace) {
      const pkg = JSON.parse(readFileSync(join(root, p.dir, 'package.json'), 'utf8'));
      for (const script of ['typecheck', 'test']) {
        if (!pkg.scripts?.[script]) {
          violations.push({ rule: 'turbo', file: `${p.dir}/package.json`, message: `missing "${script}" script, so turbo cannot run it` });
        }
      }
    }
  }

  for (const p of workspace) {
    const pkgFile = `${p.dir}/package.json`;
    for (const dep of p.deps) {
      // 1. provider SDK declared as a dependency outside allowed paths
      // A package.json dependency is allowed when the package dir itself sits under an allowed path
      // or contains one (e.g. packages/foundation may declare an SDK used only in src/identity).
      const group = config.sdkGroups.find((g) => matchSdk(dep, g.packages) !== undefined);
      if (group && !group.allowedPaths.some((a) => isAllowedPath(p.dir, [a]) || a.startsWith(`${p.dir}/`))) {
        violations.push({ rule: 'provider-sdk', file: pkgFile, message: `depends on ${group.name} SDK "${dep}"; allowed only in ${describeAllowed(group)}` });
      }
      // 3. forbidden layer packages
      const forbidden = (config.forbiddenPackages ?? []).find((f) => dep === f || dep.startsWith(f));
      if (forbidden && !(config.allowedExternalLayerPackages ?? []).includes(dep)) {
        violations.push({ rule: 'forbidden-package', file: pkgFile, message: `depends on "${dep}", which this layer must not use` });
      }
      // 2. workspace dependency direction
      if (workspaceNames.has(dep)) {
        const target = byName.get(dep)!;
        if (p.kind === 'library' && target.kind === 'app') {
          violations.push({ rule: 'workspace-deps', file: pkgFile, message: `library depends on app "${dep}"; packages/ must never depend on apps/` });
          continue;
        }
        if (p.kind === 'library' && config.moduleAllowedDeps) {
          const allowed = config.baseAllowedDeps?.[p.name] ?? config.moduleAllowedDeps;
          if (!allowed.includes(dep)) {
            violations.push({ rule: 'workspace-deps', file: pkgFile, message: `"${p.name}" may depend only on [${allowed.join(', ')}], not "${dep}"` });
          }
        }
      }
    }
  }

  // Source scan: provider imports and permission checks
  for (const file of walk(root)) {
    const rel = toPosix(relative(root, file));
    if (rel.startsWith('scripts/architecture/')) continue; // the checker names SDKs and patterns itself
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');

    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      const group = bannedBy(spec, rel, config.sdkGroups);
      if (group) {
        const line = text.slice(0, m.index).split('\n').length;
        violations.push({ rule: 'provider-sdk', file: rel, line, message: `imports ${group.name} SDK "${spec}"; allowed only in ${describeAllowed(group)}` });
      }
    }

    if (config.permissionChecks && !isTestFile(rel)) {
      lines.forEach((l, i) => {
        if (/arch-check:\s*allow-role-name/.test(l) || /arch-check:\s*allow-role-name/.test(lines[i - 1] ?? '')) return;
        for (const { re, why } of PERMISSION_PATTERNS) {
          if (re.test(l)) {
            violations.push({ rule: 'permission-check', file: rel, line: i + 1, message: `${why}; code must check permission keys` });
            break;
          }
        }
      });
    }
  }

  return violations;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = process.cwd();
  const violations = check(root);
  if (violations.length === 0) {
    console.log('architecture check: OK');
  } else {
    for (const v of violations) console.error(`[${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}  ${v.message}`);
    console.error(`\narchitecture check: ${violations.length} violation(s)`);
    process.exit(1);
  }
}
