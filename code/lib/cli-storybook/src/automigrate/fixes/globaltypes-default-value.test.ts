import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatExistingFile, JsPackageManager } from 'storybook/internal/common';

import { fs, vol } from 'memfs';
import { resolve } from 'pathe';
import { dedent } from 'ts-dedent';

import { checkFix, runFix } from '../helpers/fix-test-utils.ts';
import { globaltypesDefaultValue } from './globaltypes-default-value.ts';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('storybook/internal/common', { spy: true });

const previewConfigPath = resolve('.storybook/preview.jsx');
const options = {
  packageManager: vi.mocked(JsPackageManager.prototype),
  mainConfig: { stories: [] },
  mainConfigPath: resolve('.storybook/main.js'),
  configDir: resolve('.storybook'),
  storybookVersion: '11.0.0',
  previewConfigPath,
  storiesPaths: [],
};

const migrate = async (source: string, filePath = previewConfigPath) => {
  vol.fromJSON({ [filePath]: source });
  const failures = await runFix(globaltypesDefaultValue, {
    ...options,
    previewConfigPath: filePath,
    result: {},
  });
  return { failures, preview: fs.readFileSync(filePath, 'utf8') };
};

beforeEach(() => {
  vol.reset();
  vi.mocked(readFile).mockImplementation(fs.promises.readFile as typeof readFile);
  vi.mocked(writeFile).mockImplementation(fs.promises.writeFile as typeof writeFile);
  vi.mocked(formatExistingFile).mockImplementation(async (_path, source) => source);
});

afterEach(() => {
  vi.mocked(existsSync).mockRestore();
  vi.mocked(readFile).mockRestore();
  vi.mocked(writeFile).mockRestore();
  vi.mocked(formatExistingFile).mockRestore();
});

describe('globaltypes-default-value', () => {
  it('detects global defaults without changing the preview', async () => {
    const source = "export const globalTypes = { direction: { defaultValue: 'ltr' } };";
    vol.fromJSON({ [previewConfigPath]: source });

    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});
    expect(fs.readFileSync(previewConfigPath, 'utf8')).toBe(source);
  });

  it('moves named global defaults and keeps toolbar and JSX configuration', async () => {
    const { failures, preview } = await migrate(
      [
        'export const globalTypes = {',
        "  direction: { defaultValue: 'ltr', toolbar: { items: ['ltr', 'rtl'] } },",
        "  css: { defaultValue: 'basic', toolbar: { items: ['basic', 'wordpress'] } },",
        "  maxWidthWrapper: { defaultValue: 'none', toolbar: { items: ['none', 'wide'] } },",
        '};',
        "export const parameters = { layout: 'fullscreen' };",
        'export const decorators = [(Story) => <main><Story /></main>];',
      ].join('\n')
    );

    expect(failures).toEqual([]);
    expect(preview).toMatchInlineSnapshot(`
      "export const globalTypes = {
        direction: { toolbar: { items: ['ltr', 'rtl'] } },
        css: { toolbar: { items: ['basic', 'wordpress'] } },
        maxWidthWrapper: { toolbar: { items: ['none', 'wide'] } },
      };
      export const parameters = { layout: 'fullscreen' };
      export const decorators = [(Story) => <main><Story /></main>];
      export const initialGlobals = { direction: 'ltr', css: 'basic', maxWidthWrapper: 'none' };"
    `);
  });

  it('removes a named globalTypes export left empty after moving its defaults', async () => {
    const { failures, preview } = await migrate(
      "export const globalTypes = { direction: { defaultValue: 'ltr' } };"
    );

    expect(failures).toEqual([]);
    expect(preview).toBe("export const initialGlobals = { direction: 'ltr' };");
  });

  it('migrates defaults without changing neighboring globals that have none', async () => {
    const { failures, preview } = await migrate(dedent`
      export const globalTypes = {
        theme: { description: 'Theme', toolbar: { items: ['light', 'dark'] } },
        direction: { defaultValue: 'ltr', description: 'Direction' },
        locale: { description: 'Locale' },
      };
    `);

    expect(failures).toEqual([]);
    expect(preview).toMatchInlineSnapshot(`
      "export const globalTypes = {
        theme: { description: 'Theme', toolbar: { items: ['light', 'dark'] } },
        direction: { description: 'Direction' },
        locale: { description: 'Locale' },
      };

      export const initialGlobals = { direction: 'ltr' };"
    `);
  });

  it.each(["'rtl'", 'false', '0', "''", 'null', 'undefined', 'getDirection()'])(
    'keeps the existing initial value %s',
    async (value) => {
      const { failures, preview } = await migrate(
        [
          "export const globalTypes = { direction: { defaultValue: 'ltr', toolbar: { items: ['ltr', 'rtl'] } } };",
          `export const initialGlobals = { direction: ${value}, theme: 'dark' };`,
        ].join('\n')
      );

      expect(failures).toEqual([]);
      expect(preview).toBe(
        [
          "export const globalTypes = { direction: { toolbar: { items: ['ltr', 'rtl'] } } };",
          `export const initialGlobals = { direction: ${value}, theme: 'dark' };`,
        ].join('\n')
      );
    }
  );

  it.each([
    [
      'a source spread',
      "export const globalTypes = { ...shared, direction: { defaultValue: 'ltr' } };",
      'Cannot migrate globalTypes with spreads or dynamic keys. Set initialGlobals manually.',
    ],
    [
      'a destination spread',
      "export const globalTypes = { direction: { defaultValue: 'ltr' } }; export const initialGlobals = { ...shared };",
      'line 1: Cannot mutate initialGlobals.direction because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a function call',
      'export const globalTypes = { direction: { defaultValue: getDirection() } };',
      'Cannot migrate globalTypes.direction.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'undefined',
      'export const globalTypes = { direction: { defaultValue: undefined } };',
      'Cannot migrate globalTypes.direction.defaultValue automatically. Set initialGlobals manually.',
    ],
  ])('reports %s and leaves the preview unchanged', async (_name, source, reason) => {
    vol.fromJSON({ [previewConfigPath]: source });
    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message: reason,
      },
    ]);
    expect(preview).toBe(source);
  });

  it('leaves all defaults unchanged when a later entry cannot be migrated', async () => {
    const source = [
      'export const globalTypes = {',
      "  direction: { defaultValue: 'ltr' },",
      '  theme: { defaultValue: getTheme() },',
      '};',
    ].join('\n');

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message:
          'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
      },
    ]);
    expect(preview).toBe(source);
  });

  it('keeps an effectful default even when an initial value already exists', async () => {
    const source = [
      'export const globalTypes = { direction: { defaultValue: getDirection() } };',
      "export const initialGlobals = { direction: 'rtl' };",
    ].join('\n');

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message:
          'Cannot migrate globalTypes.direction.defaultValue automatically. Set initialGlobals manually.',
      },
    ]);
    expect(preview).toBe(source);
  });

  it.each([
    [
      'a default object',
      dedent`
        export default {
          globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } },
        };
      `,
      dedent`
        export default {
          globalTypes: { direction: { description: 'Direction' } },
          initialGlobals: { direction: 'ltr' },
        };
      `,
    ],
    [
      'a local preview object',
      dedent`
        const preview = {
          globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } },
        };
        export default preview;
      `,
      dedent`
        const preview = {
          globalTypes: { direction: { description: 'Direction' } },
          initialGlobals: { direction: 'ltr' },
        };
        export default preview;
      `,
    ],
    [
      'a satisfies wrapper',
      dedent`
        import type { Preview } from '@storybook/react-vite';
        const preview = {
          globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } },
        } satisfies Preview;
        export default preview;
      `,
      dedent`
        import type { Preview } from '@storybook/react-vite';
        const preview = {
          globalTypes: { direction: { description: 'Direction' } },
          initialGlobals: { direction: 'ltr' },
        } satisfies Preview;
        export default preview;
      `,
    ],
    [
      'an as wrapper',
      dedent`
        import type { Preview } from '@storybook/react-vite';
        export default {
          globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } },
        } as Preview;
      `,
      dedent`
        import type { Preview } from '@storybook/react-vite';
        export default {
          globalTypes: { direction: { description: 'Direction' } },
          initialGlobals: { direction: 'ltr' },
        } as Preview;
      `,
    ],
    [
      'definePreview',
      dedent`
        import { definePreview } from '@storybook/react-vite';
        export default definePreview({
          globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } },
        });
      `,
      dedent`
        import { definePreview } from '@storybook/react-vite';
        export default definePreview({
          globalTypes: { direction: { description: 'Direction' } },
          initialGlobals: { direction: 'ltr' },
        });
      `,
    ],
    [
      'named globalTypes from a local object',
      dedent`
        const defaults = {
          direction: { defaultValue: 'ltr', description: 'Direction' },
        };
        export const globalTypes = defaults;
      `,
      dedent`
        const defaults = {
          direction: { description: 'Direction' },
        };
        export const globalTypes = defaults;
        export const initialGlobals = { direction: 'ltr' };
      `,
    ],
    [
      'default globalTypes from a local object',
      dedent`
        const defaults = {
          direction: { defaultValue: 'ltr', description: 'Direction' },
        };
        export default { globalTypes: defaults };
      `,
      dedent`
        const defaults = {
          direction: { description: 'Direction' },
        };
        export default { globalTypes: defaults, initialGlobals: { direction: 'ltr' } };
      `,
    ],
  ])('migrates %s without changing its export form', async (_name, source, expected) => {
    const { failures, preview } = await migrate(source, resolve('.storybook/preview.tsx'));

    expect(failures).toEqual([]);
    expect(preview).toBe(expected);
  });

  it.each([
    '42',
    '-2.5',
    '0x10',
    'false',
    '0',
    "''",
    'null',
    "[false, 0, '', null, { size: -2 }]",
    "{ enabled: true, label: '', sizes: [-1, 2.5] }",
  ])('preserves the literal default %s', async (value) => {
    const { failures, preview } = await migrate(
      `export const globalTypes = { setting: { defaultValue: ${value}, description: 'Setting' } };`
    );

    expect(failures).toEqual([]);
    expect(preview).toBe(
      [
        "export const globalTypes = { setting: { description: 'Setting' } };",
        `export const initialGlobals = { setting: ${value} };`,
      ].join('\n')
    );
  });

  it('keeps a quoted global name', async () => {
    const { failures, preview } = await migrate(
      "export const globalTypes = { 'preferred-locale': { defaultValue: 'en', description: 'Locale' } };"
    );

    expect(failures).toEqual([]);
    expect(preview).toMatchInlineSnapshot(`
      "export const globalTypes = { 'preferred-locale': { description: 'Locale' } };
      export const initialGlobals = { 'preferred-locale': 'en' };"
    `);
  });

  it.each(['default\\u0056alue', "'default\\u0056alue'"])(
    'migrates the escaped property %s',
    async (key) => {
      const source = `export const globalTypes = { direction: { ${key}: 'ltr', description: 'Direction' } };`;
      vol.fromJSON({ [previewConfigPath]: source });

      expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

      const { failures, preview } = await migrate(source);

      expect(failures).toEqual([]);
      expect(preview).toBe(dedent`
        export const globalTypes = { direction: { description: 'Direction' } };
        export const initialGlobals = { direction: 'ltr' };
      `);
    }
  );

  it.each([
    ['no globals', 'export default {};'],
    [
      'toolbar metadata without a default',
      "export const globalTypes = { direction: { toolbar: { items: ['ltr', 'rtl'] } } };",
    ],
    [
      'a docs-table default',
      "export const globalTypes = { direction: { table: { defaultValue: { summary: 'ltr' } } } };",
    ],
    ['an argTypes default', "export const argTypes = { label: { defaultValue: 'Hello' } };"],
    ['a comment', '// globalTypes.direction.defaultValue is obsolete.\nexport default {};'],
    [
      'a comment beside spread globals',
      "import { shared } from './globals';\nexport const globalTypes = { ...shared }; // defaultValue was removed in Storybook 11.",
    ],
    [
      'a comment beside imported globals',
      "import globals from './globals';\nexport const globalTypes = globals; // defaultValue was removed in Storybook 11.",
    ],
    [
      'a docs-table default beside a spread',
      "export const globalTypes = { direction: { ...shared, table: { defaultValue: { summary: 'ltr' } } } };",
    ],
    [
      'a comment beside a preview spread',
      "import shared from './shared'; export default { ...shared }; // globalTypes.direction.defaultValue was removed",
    ],
    [
      'an argTypes default beside a preview spread',
      "import shared from './shared'; export default { ...shared, argTypes: { label: { defaultValue: 'Hello' } } };",
    ],
    [
      'computed metadata beside a docs-table default',
      dedent`
        const key = 'description';
        export const globalTypes = {
          direction: {
            [key]: 'Direction',
            table: { defaultValue: { summary: 'ltr' } },
          },
        };
      `,
    ],
    [
      'a template literal metadata key beside a comment',
      dedent`
        const key = \`description\`;
        export const globalTypes = { direction: { [key]: 'Direction' } };
        // defaultValue removed
      `,
    ],
    [
      'a computed docs-table default',
      dedent`
        const key = 'defaultValue';
        export const globalTypes = {
          direction: { table: { [key]: { summary: 'ltr' } } },
        };
      `,
    ],
    [
      'local spreads without global defaults',
      dedent`
        const direction = { table: { defaultValue: { summary: 'ltr' } } };
        const types = { direction: { ...direction } };
        export const globalTypes = { ...types };
      `,
    ],
    [
      'mixed exports without global defaults',
      dedent`
        export default { parameters: { layout: 'fullscreen' } };
        export const globalTypes = { direction: { description: 'Direction' } };
      `,
    ],
    [
      'a spread default overridden by a later global type',
      dedent`
        const types = { direction: { defaultValue: 'ltr' } };
        export const globalTypes = {
          ...types,
          direction: { description: 'Direction' },
        };
      `,
    ],
    [
      'a bigint metadata key without a default',
      "export const globalTypes = { direction: { 1n: 'metadata' } };",
    ],
    [
      'a spread default replaced by a later local spread',
      dedent`
        const defaults = { direction: { defaultValue: 'ltr' } };
        const types = { direction: { description: 'Direction' } };
        export const globalTypes = { ...defaults, ...types };
      `,
    ],
    [
      'a local preview spread without global defaults',
      dedent`
        const shared = { globalTypes: { direction: { description: 'Direction' } } };
        export default { ...shared };
      `,
    ],
    [
      'a local preview spread overridden by later global types',
      dedent`
        const shared = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        export default { ...shared, globalTypes: { direction: { description: 'Direction' } } };
      `,
    ],
    [
      'a local factory config without global defaults',
      dedent`
        import { definePreview } from '@storybook/react-vite';
        const localConfig = { globalTypes: { direction: { description: 'Direction' } } };
        export default definePreview(localConfig);
      `,
    ],
    [
      'an imported factory config',
      dedent`
        import { definePreview } from '@storybook/react-vite';
        import config from './config';
        export default definePreview(config);
      `,
    ],
    [
      'duplicate globalTypes fields without a default',
      "export default { globalTypes: {}, globalTypes: { direction: { description: 'Direction' } } };",
    ],
    [
      'a dynamic global name without a default',
      "export const globalTypes = { [getName()]: { toolbar: { items: ['ltr', 'rtl'] } } };",
    ],
    [
      'a default added by a later write',
      dedent`
        const shared = {};
        shared.direction = { defaultValue: 'ltr' };
        export const globalTypes = { ...shared };
      `,
    ],
    [
      'a custom factory config without global defaults',
      dedent`
        import { createPreview } from '@acme/storybook-config';
        export default createPreview({ globalTypes: { direction: { description: 'Direction' } } });
      `,
    ],
    [
      'boolean and null metadata keys',
      "export const globalTypes = { direction: { [true]: 'a', [null]: 'b', toolbar: {} } };",
    ],
  ])('does not apply to %s', async (_name, source) => {
    vol.fromJSON({ [previewConfigPath]: source });

    expect(await checkFix(globaltypesDefaultValue, options)).toBeNull();
    expect(await runFix(globaltypesDefaultValue, { ...options, result: {} })).toEqual([]);
    expect(fs.readFileSync(previewConfigPath, 'utf8')).toBe(source);
  });

  it('does not apply when there is no preview file', async () => {
    expect(
      await checkFix(globaltypesDefaultValue, { ...options, previewConfigPath: undefined })
    ).toBeNull();
    expect(vol.toJSON()).toEqual({});
  });

  it('does not change matching properties in main, manager or story files', async () => {
    const managerPath = resolve('.storybook/manager.js');
    const storyPath = resolve('src/Direction.stories.js');
    const source = "export default { globalTypes: { direction: { defaultValue: 'ltr' } } };";
    const files = {
      [options.mainConfigPath]: source,
      [managerPath]: source,
      [storyPath]: source,
      [previewConfigPath]: 'export default {};',
    };
    vol.fromJSON(files);
    vi.mocked(existsSync).mockImplementation(fs.existsSync);
    const project = { ...options, storiesPaths: [storyPath] };

    expect(await checkFix(globaltypesDefaultValue, project)).toBeNull();
    expect(await runFix(globaltypesDefaultValue, { ...project, result: {} })).toEqual([]);
    expect(vol.toJSON()).toEqual(files);
  });

  it('does not offer or change an already migrated preview', async () => {
    const { failures, preview } = await migrate(
      "export const globalTypes = { direction: { defaultValue: 'ltr', description: 'Direction' } };"
    );
    expect(failures).toEqual([]);

    expect(await checkFix(globaltypesDefaultValue, options)).toBeNull();
    expect(await runFix(globaltypesDefaultValue, { ...options, result: {} })).toEqual([]);
    expect(fs.readFileSync(previewConfigPath, 'utf8')).toBe(preview);
  });

  it('preserves comments and CRLF line endings', async () => {
    const { failures, preview } = await migrate(
      [
        '// The toolbar controls the writing direction.',
        'export const globalTypes = {',
        '  direction: {',
        "    defaultValue: 'ltr',",
        "    description: 'Direction', // Used in the toolbar.",
        '  },',
        '};',
      ].join('\r\n')
    );

    expect(failures).toEqual([]);
    expect(preview).toBe(
      [
        '// The toolbar controls the writing direction.',
        'export const globalTypes = {',
        '  direction: {',
        "    description: 'Direction', // Used in the toolbar.",
        '  },',
        '};',
        '',
        "export const initialGlobals = { direction: 'ltr' };",
      ].join('\r\n')
    );
  });

  it.each([
    [
      'a dynamic global name',
      "export const globalTypes = { [getName()]: { defaultValue: 'ltr' } };",
      'Cannot migrate globalTypes with spreads or dynamic keys. Set initialGlobals manually.',
    ],
    [
      'duplicate global names',
      "export const globalTypes = { direction: { defaultValue: 'ltr' }, direction: { defaultValue: 'rtl' } };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains duplicate field. Set initialGlobals manually.',
    ],
    [
      'duplicate defaults',
      "export const globalTypes = { direction: { defaultValue: 'ltr', defaultValue: 'rtl' } };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains duplicate field. Set initialGlobals manually.',
    ],
    [
      'a spread inside a global type',
      "export const globalTypes = { direction: { defaultValue: 'ltr', ...shared } };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default getter',
      "export const globalTypes = { direction: { get defaultValue() { return 'ltr'; } } };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains unsupported member. Set initialGlobals manually.',
    ],
    [
      'a shared global type',
      "const direction = { defaultValue: 'ltr' };\nexport const globalTypes = { direction };\nexport const other = direction;",
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains unsupported member. Set initialGlobals manually.',
    ],
    [
      'a shared globalTypes object',
      "const defaults = { direction: { defaultValue: 'ltr' } }; export const globalTypes = defaults; export const other = defaults;",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains unsupported member. Set initialGlobals manually.',
    ],
    [
      'duplicate globalTypes fields',
      "export default { globalTypes: {}, globalTypes: { direction: { defaultValue: 'ltr' } } };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains duplicate field. Set initialGlobals manually.',
    ],
    [
      'a later preview spread',
      "export default { globalTypes: { direction: { defaultValue: 'ltr' } }, ...shared };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'imported initial globals',
      "import globals from './globals';\nexport const initialGlobals = globals;\nexport const globalTypes = { direction: { defaultValue: 'ltr' } };",
      'line 2: Cannot mutate initialGlobals.direction because the target contains unsupported member. Set initialGlobals manually.',
    ],
    [
      'duplicate initial globals',
      "export const globalTypes = { direction: { defaultValue: 'ltr' } };\nexport const initialGlobals = { direction: 'ltr', direction: 'rtl' };",
      'line 2: Cannot mutate initialGlobals.direction because the target contains duplicate field. Set initialGlobals manually.',
    ],
    [
      'a nested function call',
      'export const globalTypes = { theme: { defaultValue: { color: getColor() } } };',
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'an array containing a function call',
      'export const globalTypes = { theme: { defaultValue: [1, getColor()] } };',
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a computed property in the default value',
      "export const globalTypes = { theme: { defaultValue: { ['a']: 1 } } };",
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a function inside a default array',
      'export const globalTypes = { theme: { defaultValue: [() => 1] } };',
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a bigint inside a default object',
      'export const globalTypes = { theme: { defaultValue: { m: 1n } } };',
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a regular expression inside a nested default object',
      'export const globalTypes = { theme: { defaultValue: { a: { b: { c: /x/ } } } } };',
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a template literal default',
      'export const globalTypes = { direction: { defaultValue: `ltr` } };',
      'Cannot migrate globalTypes.direction.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a spread in the default value',
      'export const globalTypes = { theme: { defaultValue: { ...shared } } };',
      'Cannot migrate globalTypes.theme.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a member expression',
      'export const globalTypes = { direction: { defaultValue: defaults.direction } };',
      'Cannot migrate globalTypes.direction.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a computed property expression',
      "export const globalTypes = { direction: { ['default' + 'Value']: 'ltr' } };",
      'line 1: Cannot mutate globalTypes.direction.defaultValue because the target contains dynamic key. Set initialGlobals manually.',
    ],
    [
      'an imported property name',
      dedent`
        import { defaultKey } from './keys';
        export const globalTypes = { direction: { [defaultKey]: 'ltr' } };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains dynamic key. Set initialGlobals manually.',
    ],
    [
      'named global types after a default export',
      dedent`
        export default { parameters: { layout: 'fullscreen' } };
        export const globalTypes = { direction: { defaultValue: 'ltr' } };
      `,
      'line 1: Cannot mutate mixed default and named config exports. Set initialGlobals manually.',
    ],
    [
      'named global types before a default export',
      dedent`
        export const globalTypes = { direction: { defaultValue: 'ltr' } };
        export default { parameters: { layout: 'fullscreen' } };
      `,
      'line 2: Cannot mutate mixed default and named config exports. Set initialGlobals manually.',
    ],
    [
      'global types supplied by a local spread',
      dedent`
        const types = { direction: { defaultValue: 'ltr' } };
        export const globalTypes = { ...types };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default supplied by a local spread',
      dedent`
        const defaults = { defaultValue: 'ltr' };
        export const globalTypes = { direction: { ...defaults } };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'global types supplied by nested local spreads',
      dedent`
        const defaults = { direction: { defaultValue: 'ltr' } };
        const types = { ...defaults };
        export default { globalTypes: { ...types } };
      `,
      'line 3: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default supplied by a local preview spread',
      dedent`
        const shared = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        export default { ...shared };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default in a local factory config',
      dedent`
        import { definePreview } from '@storybook/react-vite';
        const localConfig = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        export default definePreview(localConfig);
      `,
      'Cannot mutate a config without a static object initializer. Set initialGlobals manually.',
    ],
    [
      'a default kept by the later of two local spreads',
      dedent`
        const defaults = { direction: { defaultValue: 'ltr' } };
        const types = { direction: { description: 'Direction' } };
        export const globalTypes = { ...types, ...defaults };
      `,
      'line 3: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a dynamic global name beside a default',
      "export const globalTypes = { [getName()]: { toolbar: {} }, direction: { defaultValue: 'ltr' } };",
      'Cannot migrate globalTypes with spreads or dynamic keys. Set initialGlobals manually.',
    ],
    [
      'named global types beside an imported preview spread',
      dedent`
        import shared from './shared';
        export default { ...shared };
        export const globalTypes = { direction: { defaultValue: 'ltr' } };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'global types from a constant passed to a call',
      dedent`
        const types = { direction: { defaultValue: 'ltr' } };
        register(types);
        export const globalTypes = { ...types };
      `,
      'line 3: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default in a local factory config held by an alias',
      dedent`
        import { definePreview } from '@storybook/react-vite';
        const config = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        const preview = definePreview(config);
        export default preview;
      `,
      'Cannot mutate a config without a static object initializer. Set initialGlobals manually.',
    ],
    [
      'a default before an imported spread',
      dedent`
        import shared from './shared';
        export const globalTypes = { direction: { defaultValue: 'ltr' }, ...shared };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a config wrapped in a custom factory',
      dedent`
        import { createPreview } from '@acme/storybook-config';
        export default createPreview({ globalTypes: { direction: { defaultValue: 'ltr' } } });
      `,
      'line 2: Cannot mutate an arbitrary config factory call. Set initialGlobals manually.',
    ],
    [
      'a config from a namespace factory',
      dedent`
        import * as sb from '@storybook/react-vite';
        export default sb.definePreview({ globalTypes: { direction: { defaultValue: 'ltr' } } });
      `,
      'line 2: Cannot mutate an arbitrary config factory call. Set initialGlobals manually.',
    ],
    [
      'a reassigned config binding',
      dedent`
        let preview = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        if (process.env.CI) {
          preview = { ...preview, parameters: {} };
        }
        export default preview;
      `,
      'line 1: Cannot mutate a shared or reassigned config binding. Set initialGlobals manually.',
    ],
    [
      'a conditional module.exports',
      dedent`
        if (typeof window !== 'undefined') {
          module.exports = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        }
      `,
      'line 2: Cannot mutate a config declared inside a function or conditional. Set initialGlobals manually.',
    ],
    [
      'a default inherited through a member spread',
      dedent`
        const shared = { theme: { defaultValue: 'light', description: 'Theme' } };
        export const globalTypes = {
          ...shared,
          theme: { ...shared.theme, toolbar: { items: ['light', 'dark'] } },
        };
      `,
      'line 4: Cannot mutate globalTypes.theme.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a member spread default beside a movable default',
      dedent`
        const shared = { theme: { defaultValue: 'light', description: 'Theme' } };
        export const globalTypes = {
          ...shared,
          theme: { ...shared.theme, toolbar: { items: ['light', 'dark'] } },
          locale: { defaultValue: 'en' },
        };
      `,
      'line 4: Cannot mutate globalTypes.theme.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default held by a member alias',
      dedent`
        const shared = { theme: { defaultValue: 'light' } };
        const theme = shared.theme;
        export const globalTypes = { ...shared, theme: { ...theme, toolbar: {} } };
      `,
      'line 3: Cannot mutate globalTypes.theme.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default held by a member of a local object',
      dedent`
        const toolbars = { direction: { defaultValue: 'ltr' } };
        export const globalTypes = { direction: toolbars.direction };
      `,
      'line 2: Cannot mutate globalTypes.direction.defaultValue because the target contains unsupported member. Set initialGlobals manually.',
    ],
    [
      'an exported global types object passed to a call',
      dedent`
        export const globalTypes = { direction: { defaultValue: 'ltr' } };
        register(globalTypes);
      `,
      'line 1: Cannot mutate the shared or reassigned globalTypes export. Set initialGlobals manually.',
    ],
    [
      'a global type with an imported spread beside a default',
      dedent`
        import { localeGlobal } from '@acme/storybook-shared';
        export const globalTypes = {
          locale: { ...localeGlobal, toolbar: { icon: 'globe' } },
          theme: { defaultValue: 'light' },
        };
      `,
      'line 3: Cannot mutate globalTypes.locale.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a default inside a conditional spread beside another default',
      dedent`
        export const globalTypes = {
          debug: { ...(isDev ? { defaultValue: true } : {}), toolbar: {} },
          theme: { defaultValue: 'light' },
        };
      `,
      'line 2: Cannot mutate globalTypes.debug.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'an imported global type beside a default',
      dedent`
        import { locale } from './globals';
        export const globalTypes = { locale, theme: { defaultValue: 'light' } };
      `,
      'line 2: Cannot mutate globalTypes.locale.defaultValue because the target contains unsupported member. Set initialGlobals manually.',
    ],
    [
      'a member of an object with a later imported spread',
      dedent`
        import { overrides } from './brand';
        const types = { theme: { toolbar: {} }, ...overrides };
        export const globalTypes = { theme: { ...types.theme }, locale: { defaultValue: 'en' } };
      `,
      'line 3: Cannot mutate globalTypes.theme.defaultValue because the target contains spread field. Set initialGlobals manually.',
    ],
    [
      'a CommonJS config held by an alias',
      dedent`
        const config = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        const preview = config;
        module.exports = preview;
      `,
      'Cannot mutate a config without a static object initializer. Set initialGlobals manually.',
    ],
    [
      'global types in one of two module.exports assignments',
      dedent`
        if (process.env.CI) {
          module.exports = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        } else {
          module.exports = { parameters: {} };
        }
      `,
      'line 4: Cannot mutate a config declared inside a function or conditional. Set initialGlobals manually.',
    ],
    [
      'a reassigned global types binding exported by name',
      dedent`
        let globalTypes = { direction: { defaultValue: 'ltr' } };
        if (process.env.CI) {
          globalTypes = {};
        }
        export { globalTypes };
      `,
      'line 1: Cannot mutate the shared or reassigned globalTypes export. Set initialGlobals manually.',
    ],
    [
      'a custom factory config held by a constant',
      dedent`
        import { createPreview } from '@acme/storybook-config';
        const config = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        export default createPreview(config);
      `,
      'Cannot mutate a config without a static object initializer. Set initialGlobals manually.',
    ],
    [
      'a factory config exported as default by name',
      dedent`
        import { definePreview } from '@storybook/react-vite';
        const config = { globalTypes: { direction: { defaultValue: 'ltr' } } };
        const preview = definePreview(config);
        export { preview as default };
      `,
      'Cannot migrate globalTypes.direction.defaultValue automatically. Set initialGlobals manually.',
    ],
    [
      'a reassigned global types binding in a config held by an alias',
      dedent`
        let types = { direction: { defaultValue: 'ltr' } };
        if (process.env.CI) {
          types = {};
        }
        const config = { globalTypes: types };
        const preview = config;
        export default preview;
      `,
      'Cannot mutate a config without a static object initializer. Set initialGlobals manually.',
    ],
  ])('requires a manual migration for %s', async (_name, source, reason) => {
    vol.fromJSON({ [previewConfigPath]: source });
    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message: reason,
      },
    ]);
    expect(preview).toBe(source);
  });

  it('migrates global types through multiple local aliases', async () => {
    const source = dedent`
      const defaults = {
        direction: { defaultValue: 'ltr', description: 'Direction' },
      };
      const types = defaults;
      export const globalTypes = types;
    `;
    vol.fromJSON({ [previewConfigPath]: source });

    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([]);
    expect(preview).toBe(dedent`
      const defaults = {
        direction: { description: 'Direction' },
      };
      const types = defaults;
      export const globalTypes = types;
      export const initialGlobals = { direction: 'ltr' };
    `);
  });

  it.each(['as const', 'satisfies Preview'])(
    'migrates a factory argument wrapped in %s',
    async (wrapper) => {
      const source = dedent`
        import { definePreview, type Preview } from '@storybook/react-vite';
        export default definePreview({
          globalTypes: { direction: { defaultValue: 'ltr' } },
        } ${wrapper});
      `;
      vol.fromJSON({ [previewConfigPath]: source });

      expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

      const { failures, preview } = await migrate(source);

      expect(failures).toEqual([]);
      expect(preview).toBe(dedent`
        import { definePreview, type Preview } from '@storybook/react-vite';
        export default definePreview({
          initialGlobals: { direction: 'ltr' },
        } ${wrapper});
      `);
    }
  );

  it('reports a computed default key without changing the preview', async () => {
    const source = dedent`
      const key = 'defaultValue';
      export const globalTypes = {
        direction: { [key]: 'ltr' },
      };
    `;
    vol.fromJSON({ [previewConfigPath]: source });

    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message: expect.stringContaining('contains dynamic key. Set initialGlobals manually.'),
      },
    ]);
    expect(preview).toBe(source);
  });

  it.each([
    [
      'an unreadable default',
      dedent`
        export const globalTypes = {
          direction: { defaultValue: 'ltr', ...shared },
        };
      `,
    ],
    [
      'a shared global type that cannot be edited',
      dedent`
        const direction = { defaultValue: 'ltr' };
        export const globalTypes = { direction };
        export const other = direction;
      `,
    ],
  ])('includes the source line when reporting %s', async (_name, source) => {
    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message: expect.stringContaining('line 2:'),
      },
    ]);
    expect(failures[0].message).toContain('initialGlobals');
    expect(preview).toBe(source);
  });
});
