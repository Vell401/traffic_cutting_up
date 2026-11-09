import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');

// Static simulation of this repository's Docker ignore rules: ordered negation,
// root-relative paths, *, ** and excluded parent directories. No Git or Docker
// dependency: this regression test must itself run inside the build stage.
function contextFilter(source: string) {
  const rules = source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const include = line.startsWith('!');
    const pattern = (include ? line.slice(1) : line).replace(/^\/+|\/+$/g, '');
    let expression = '';
    for (let i = 0; i < pattern.length; i++) {
      if (pattern.slice(i, i + 3) === '**/') { expression += '(?:.*/)?'; i += 2; }
      else if (pattern.slice(i, i + 2) === '**') { expression += '.*'; i++; }
      else if (pattern[i] === '*') expression += '[^/]*';
      else expression += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return { include, matcher: new RegExp(`^${expression}$`) };
  });
  return (path: string) => {
    const parts = path.split('/');
    return parts.every((_, index) => {
      const candidate = parts.slice(0, index + 1).join('/');
      let included = true;
      for (const rule of rules) if (rule.matcher.test(candidate)) included = rule.include;
      return included;
    });
  };
}

const ignore = read('.dockerignore');
const included = contextFilter(ignore);

describe('tested Docker build context', () => {
  it('includes the deployment tests and their required repository fixtures', () => {
    for (const path of [
      'tests/mapDeployment.test.ts', 'tests/dockerContext.test.ts',
      '.github/workflows/test.yml', '.github/workflows/deploy.yml',
      'compose.yaml', 'deploy/deploy.sh', 'deploy/docker/Caddyfile',
      'docs/a45-textures.json', 'docs/porsche-optimization.json',
      'public/models/mercedes-a45s.glb', 'public/models/mercedes-w204.glb',
      'public/models/mercedes-w204.manifest.json', 'public/models/porsche-911-irl10.glb',
      'public/THIRD_PARTY_LICENSES.txt',
    ]) {
      expect(existsSync(new URL(path, root)), path).toBe(true);
      expect(included(path), path).toBe(true);
    }
    // Demonstrate that the old blanket exclusion really loses the fixtures.
    const oldContext = contextFilter(`${ignore}\n.github\n`);
    expect(oldContext('.github/workflows/test.yml')).toBe(false);
    expect(oldContext('.github/workflows/deploy.yml')).toBe(false);
  });

  it('does not admit dependencies, Git metadata, other GitHub files or local secrets', () => {
    for (const path of [
      'node_modules/vitest/package.json', '.git/config', '.git/credentials',
      '.github/credentials', '.github/workflows/private.yml',
      '.github/workflows/nested/secret.yml', '.github/actions/private/action.yml',
      '.env', '.env.production', '.npmrc', '.ssh/id_ed25519', '.aws/credentials',
      'secrets/token', 'deploy/.env', 'deploy/.env.production',
      'deploy/certs/cert.pem', 'deploy/certs/private.key',
      'dist/index.html', 'dist-server/main.js', 'data/traffic.db',
    ]) expect(included(path), path).toBe(false);
  });

  it('keeps the default test gate and shared build stage for both image targets', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('ARG SKIP_TESTS=0');
    expect(dockerfile).toContain('COPY . .');
    expect(dockerfile).toMatch(/if \[ "\$SKIP_TESTS" = 1 \]; then[^\n]+else npx vitest run; fi/);
    expect(dockerfile).toContain('npm run typecheck');
    expect(dockerfile).toContain('npm run build:server');
    for (const [target, output] of [['server', 'dist-server'], ['web', 'dist']]) {
      const stage = dockerfile.split(new RegExp(`FROM [^\\n]+ AS ${target}\\n`))[1]?.split('\nFROM ')[0];
      expect(stage, target).toContain(`COPY --from=build /app/${output} `);
      expect(read('compose.yaml')).toContain(`target: ${target}`);
    }
  });
});
