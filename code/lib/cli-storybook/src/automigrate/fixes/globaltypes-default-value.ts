import { HandledError } from 'storybook/internal/common';
import {
  type ConfigFile,
  type CsfObject,
  type ESTree as E,
  printCsfPath,
  staticKey,
  unwrapExpression,
} from 'storybook/internal/csf-tools';

import picocolors from 'picocolors';

import type { Fix } from '../types.ts';

const readForMigration = (object: CsfObject, path: string[]) => {
  const found = object.inspect(path);
  if (found.kind === 'unreadable') {
    throw new HandledError(`${found.diagnostic.message} Set initialGlobals manually.`);
  }
  return found.kind === 'value' ? found.node : undefined;
};

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

const migrate = (object: ConfigFile) => {
  const globalTypes = unwrapExpression(object.getFieldNode(['globalTypes']));
  if (!globalTypes) {
    return;
  }
  if (globalTypes.type !== 'ObjectExpression') {
    return;
  }
  const hasDefaults = globalTypes.properties.some((property) => {
    if (property.type !== 'Property') {
      return false;
    }
    const value = unwrapExpression(property.value);
    if (value.type === 'ObjectExpression') {
      return value.properties.some((member) => staticKey(member) === 'defaultValue');
    }
    const name = staticKey(property);
    return (
      name !== undefined && object.inspect(['globalTypes', name, 'defaultValue']).kind === 'value'
    );
  });
  if (!hasDefaults) {
    return;
  }

  for (const property of globalTypes.properties) {
    const name = staticKey(property);
    if (name === undefined) {
      throw new HandledError(
        'Cannot migrate globalTypes with spreads or dynamic keys. Set initialGlobals manually.'
      );
    }
    const legacyPath = ['globalTypes', name, 'defaultValue'];
    const initialPath = ['initialGlobals', name];
    const defaultValue = readForMigration(object, legacyPath);
    if (!defaultValue) {
      continue;
    }
    if (!isLiteralData(defaultValue)) {
      throw new HandledError(
        `Cannot migrate ${printCsfPath(legacyPath)} automatically. Set ${printCsfPath(initialPath)} manually.`
      );
    }
    const result = readForMigration(object, initialPath)
      ? object.remove(legacyPath)
      : object.move(legacyPath, initialPath);
    if (!result.ok) {
      throw new HandledError(`${result.diagnostic.message} Set initialGlobals manually.`);
    }
  }
};

export const globaltypesDefaultValue: Fix = {
  id: 'globaltypes-default-value',
  link: 'https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#toolbar-globaltypes-entries-index-signature-and-defaultvalue-removed',
  prompt: () =>
    `Move ${picocolors.cyan('globalTypes')} default values to ${picocolors.cyan('initialGlobals')}`,
  transform: () => [
    {
      filter: { kind: ['preview'], code: 'defaultValue' },
      editConfig: migrate,
    },
  ],
};
