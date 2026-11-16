import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as common from 'storybook/internal/common';

import { fs, vol } from 'memfs';
import { resolve } from 'pathe';

import { checkFix, runFix } from '../helpers/fix-test-utils.ts';
import { globaltypesDefaultValue } from './globaltypes-default-value.ts';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

const previewConfigPath = resolve('.storybook/preview.jsx');
const options = {
  packageManager: common.JsPackageManager.prototype,
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
  vi.spyOn(common, 'formatExistingFile').mockImplementation(async (_path, source) => source);
});

afterEach(() => {
  vi.mocked(existsSync).mockRestore();
  vi.mocked(readFile).mockRestore();
  vi.mocked(writeFile).mockRestore();
  vi.mocked(common.formatExistingFile).mockRestore();
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
    ],
    [
      'a destination spread',
      "export const globalTypes = { direction: { defaultValue: 'ltr' } }; export const initialGlobals = { ...shared };",
    ],
    [
      'a function call',
      'export const globalTypes = { direction: { defaultValue: getDirection() } };',
    ],
    ['undefined', 'export const globalTypes = { direction: { defaultValue: undefined } };'],
  ])('reports %s and leaves the preview unchanged', async (_name, source) => {
    vol.fromJSON({ [previewConfigPath]: source });
    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message: expect.stringContaining('initialGlobals'),
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
        message: expect.stringContaining('initialGlobals'),
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
        message: expect.stringContaining('initialGlobals'),
      },
    ]);
    expect(preview).toBe(source);
  });

  it.each([
    [
      'a default object',
      "export default { globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } } };",
      "export default { globalTypes: { direction: { description: 'Direction' } }, initialGlobals: { direction: 'ltr' } };",
    ],
    [
      'a local preview object',
      "const preview = { globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } } }; export default preview;",
      "const preview = { globalTypes: { direction: { description: 'Direction' } }, initialGlobals: { direction: 'ltr' } }; export default preview;",
    ],
    [
      'a satisfies wrapper',
      "import type { Preview } from '@storybook/react-vite';\nconst preview = { globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } } } satisfies Preview; export default preview;",
      "import type { Preview } from '@storybook/react-vite';\nconst preview = { globalTypes: { direction: { description: 'Direction' } }, initialGlobals: { direction: 'ltr' } } satisfies Preview; export default preview;",
    ],
    [
      'an as wrapper',
      "import type { Preview } from '@storybook/react-vite';\nexport default { globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } } } as Preview;",
      "import type { Preview } from '@storybook/react-vite';\nexport default { globalTypes: { direction: { description: 'Direction' } }, initialGlobals: { direction: 'ltr' } } as Preview;",
    ],
    [
      'definePreview',
      "import { definePreview } from '@storybook/react-vite';\nexport default definePreview({ globalTypes: { direction: { defaultValue: 'ltr', description: 'Direction' } } });",
      "import { definePreview } from '@storybook/react-vite';\nexport default definePreview({ globalTypes: { direction: { description: 'Direction' } }, initialGlobals: { direction: 'ltr' } });",
    ],
    [
      'named globalTypes from a local object',
      "const defaults = { direction: { defaultValue: 'ltr', description: 'Direction' } }; export const globalTypes = defaults;",
      "const defaults = { direction: { description: 'Direction' } }; export const globalTypes = defaults;\nexport const initialGlobals = { direction: 'ltr' };",
    ],
    [
      'default globalTypes from a local object',
      "const defaults = { direction: { defaultValue: 'ltr', description: 'Direction' } }; export default { globalTypes: defaults };",
      "const defaults = { direction: { description: 'Direction' } }; export default { globalTypes: defaults, initialGlobals: { direction: 'ltr' } };",
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
    ],
    [
      'duplicate global names',
      "export const globalTypes = { direction: { defaultValue: 'ltr' }, direction: { defaultValue: 'rtl' } };",
    ],
    [
      'duplicate defaults',
      "export const globalTypes = { direction: { defaultValue: 'ltr', defaultValue: 'rtl' } };",
    ],
    [
      'a spread inside a global type',
      "export const globalTypes = { direction: { defaultValue: 'ltr', ...shared } };",
    ],
    [
      'a default getter',
      "export const globalTypes = { direction: { get defaultValue() { return 'ltr'; } } };",
    ],
    [
      'a shared global type',
      "const direction = { defaultValue: 'ltr' };\nexport const globalTypes = { direction };\nexport const other = direction;",
    ],
    [
      'a shared globalTypes object',
      "const defaults = { direction: { defaultValue: 'ltr' } }; export const globalTypes = defaults; export const other = defaults;",
    ],
    [
      'duplicate globalTypes fields',
      "export default { globalTypes: {}, globalTypes: { direction: { defaultValue: 'ltr' } } };",
    ],
    [
      'a later preview spread',
      "export default { globalTypes: { direction: { defaultValue: 'ltr' } }, ...shared };",
    ],
    [
      'imported initial globals',
      "import globals from './globals';\nexport const initialGlobals = globals;\nexport const globalTypes = { direction: { defaultValue: 'ltr' } };",
    ],
    [
      'duplicate initial globals',
      "export const globalTypes = { direction: { defaultValue: 'ltr' } };\nexport const initialGlobals = { direction: 'ltr', direction: 'rtl' };",
    ],
    [
      'a nested function call',
      'export const globalTypes = { theme: { defaultValue: { color: getColor() } } };',
    ],
    [
      'a spread in the default value',
      'export const globalTypes = { theme: { defaultValue: { ...shared } } };',
    ],
    [
      'a member expression',
      'export const globalTypes = { direction: { defaultValue: defaults.direction } };',
    ],
  ])('requires a manual migration for %s', async (_name, source) => {
    vol.fromJSON({ [previewConfigPath]: source });
    expect(await checkFix(globaltypesDefaultValue, options)).toEqual({});

    const { failures, preview } = await migrate(source);

    expect(failures).toEqual([
      {
        file: previewConfigPath,
        kind: 'preview',
        message: expect.stringContaining('initialGlobals'),
      },
    ]);
    expect(preview).toBe(source);
  });
});
