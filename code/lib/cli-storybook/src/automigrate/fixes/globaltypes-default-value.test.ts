import { readFile, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as common from 'storybook/internal/common';

import { fs, vol } from 'memfs';
import { resolve } from 'pathe';

import { checkFix, runFix } from '../helpers/fix-test-utils.ts';
import { globaltypesDefaultValue } from './globaltypes-default-value.ts';

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

const migrate = async (source: string) => {
  vol.fromJSON({ [previewConfigPath]: source });
  const failures = await runFix(globaltypesDefaultValue, { ...options, result: {} });
  return { failures, preview: fs.readFileSync(previewConfigPath, 'utf8') };
};

beforeEach(() => {
  vol.reset();
  vi.mocked(readFile).mockImplementation(fs.promises.readFile as typeof readFile);
  vi.mocked(writeFile).mockImplementation(fs.promises.writeFile as typeof writeFile);
  vi.spyOn(common, 'formatExistingFile').mockImplementation(async (_path, source) => source);
});

afterEach(() => {
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
});
