import { HandledError } from 'storybook/internal/common';
import {
  type ConfigFile,
  type CsfKeys,
  type ESTree as E,
  printCsfPath,
  staticKey,
  unwrapExpression,
} from 'storybook/internal/csf-tools';

import picocolors from 'picocolors';

import { editParsedFile, readForEdit } from '../helpers/edit-parsed-file.ts';
import type { Fix } from '../types.ts';

const isLiteralData = (node: E.Expression): boolean => {
  const value = unwrapExpression(node);
  switch (value.type) {
    case 'Literal':
      return value.value === null || ['string', 'number', 'boolean'].includes(typeof value.value);
    case 'UnaryExpression': {
      const argument = unwrapExpression(value.argument);
      return (
        value.operator === '-' && argument.type === 'Literal' && typeof argument.value === 'number'
      );
    }
    case 'ArrayExpression':
      return value.elements.every(
        (element) =>
          element === null || (element.type !== 'SpreadElement' && isLiteralData(element))
      );
    case 'ObjectExpression':
      return value.properties.every(
        (property) =>
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.method &&
          !property.computed &&
          staticKey(property) !== undefined &&
          isLiteralData(property.value)
      );
    default:
      return false;
  }
};

// A global type this file gives a default: a `defaultValue` key, or a key it cannot name that may be one.
const hasDefault = (globalType: CsfKeys | undefined) =>
  globalType !== undefined &&
  (globalType.keys.includes('defaultValue') || globalType.computed.length > 0);

const migrate = (object: ConfigFile) => {
  const globalTypes = object.getKeys(['globalTypes']);
  if (!globalTypes) {
    return;
  }
  const withDefault = new Set(
    globalTypes.keys.filter((name) => hasDefault(object.getKeys(['globalTypes', name])))
  );
  if (withDefault.size === 0 && !globalTypes.computed.some(hasDefault)) {
    return;
  }

  // Once the file shows a default, every global type has to be readable: one that is not may hold
  // a default that would stay behind.
  for (const name of globalTypes.keys) {
    const legacyPath = ['globalTypes', name, 'defaultValue'];
    const initialPath = ['initialGlobals', name];
    const defaultValue = readForEdit(object, legacyPath);
    // A default that the edit cannot address, such as a named export beside a default export,
    // reads as missing here; moving it anyway reports why.
    if (!defaultValue && !withDefault.has(name)) {
      continue;
    }
    if (defaultValue && !isLiteralData(defaultValue)) {
      throw new HandledError(`Cannot migrate ${printCsfPath(legacyPath)} automatically.`);
    }
    const result = readForEdit(object, initialPath)
      ? object.remove(legacyPath)
      : object.move(legacyPath, initialPath);
    if (result.ok && !result.changed) {
      throw new HandledError(`Cannot migrate ${printCsfPath(legacyPath)} automatically.`);
    }
  }
  // The edits above prove their own targets. A spread this file does not show, or a global type
  // with a name it cannot read, may still replace a moved default or hold one that stays behind.
  if (globalTypes.external || globalTypes.computed.length > 0) {
    throw new HandledError('Cannot migrate globalTypes with spreads or dynamic keys.');
  }
};

export const globaltypesDefaultValue: Fix = {
  id: 'globaltypes-default-value',
  link: 'https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#toolbar-globaltypes-entries-index-signature-and-defaultvalue-removed',
  prompt: () =>
    `Move ${picocolors.cyan('globalTypes')} default values to ${picocolors.cyan('initialGlobals')}`,
  transform: () => [
    {
      filter: { kind: ['preview'] },
      editConfig: (config) => editParsedFile(config, migrate, 'Set initialGlobals manually.'),
    },
  ],
};
