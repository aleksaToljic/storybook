import { HandledError } from 'storybook/internal/common';
import { type CsfObject, staticKey, unwrapExpression } from 'storybook/internal/csf-tools';

import picocolors from 'picocolors';

import { readForEdit } from '../helpers/edit-parsed-file.ts';
import type { Fix } from '../types.ts';

const migrate = (object: CsfObject) => {
  const globalTypes = unwrapExpression(readForEdit(object, ['globalTypes']));
  if (!globalTypes) {
    return;
  }
  if (globalTypes.type !== 'ObjectExpression') {
    throw new HandledError('Cannot read globalTypes automatically. Set initialGlobals manually.');
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
    const defaultValue = unwrapExpression(readForEdit(object, legacyPath));
    if (!defaultValue) {
      continue;
    }
    if (defaultValue.type !== 'Literal' || typeof defaultValue.value !== 'string') {
      throw new HandledError(
        `Cannot migrate globalTypes.${name}.defaultValue automatically. Set initialGlobals.${name} manually.`
      );
    }
    if (readForEdit(object, initialPath)) {
      object.remove(legacyPath);
    } else {
      object.move(legacyPath, initialPath);
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
