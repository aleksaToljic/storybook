import type { ConfigFile } from './ConfigFile.ts';
import { exportedName, isModuleExports } from './ConfigObject.ts';
import type { CsfPath } from './CsfObjectPath.ts';
import {
  type E,
  type Node,
  isStringLiteral,
  staticKey,
  unwrapExpression,
  withoutTypeCalls,
} from './estree/ast.ts';
import { resolveExpression } from './estree/values.ts';

/**
 * The keys `ConfigFile.getKeys` found in an object literal, in the order the file first defines
 * them. `computed` holds what each member whose key cannot be named holds, and `external` means a
 * spread the file does not show can add or replace members.
 */
export type CsfKeys = { keys: string[]; computed: (CsfKeys | undefined)[]; external: boolean };

// The members an object literal ends up with, later ones replacing earlier ones.
type Shape = { members: Map<string, E.ObjectProperty>; computed: Node[]; external: boolean };

const memberKey = (member: E.MemberExpression) => {
  if (!member.computed) {
    return member.property.type === 'Identifier' ? member.property.name : undefined;
  }
  return isStringLiteral(member.property) ? member.property.value : undefined;
};

export const getConfigKeys = (config: ConfigFile, path: CsfPath): CsfKeys | undefined => {
  const { editor } = config;
  const { scopes } = editor;

  // Guards against values that refer to themselves, such as `var types = { ...types }`.
  const following = new Set<Node>();
  const shaping = new Set<Node>();
  const listing = new Set<Node>();
  // An object spread twice, such as `{ ...base, ...base }`, is read once.
  const shapes = new Map<Node, Shape>();

  // The expression a value is declared with, through local constants, members of local object
  // literals and TypeScript wrappers.
  const follow = (node: Node | null | undefined): Node | undefined => {
    const entered: Node[] = [];
    const enter = (value: Node) => {
      following.add(value);
      entered.push(value);
    };
    try {
      let value = unwrapExpression(node ?? undefined);
      for (;;) {
        if (!value || following.has(value)) {
          return undefined;
        }
        if (value.type === 'Identifier') {
          // A reassigned binding is read as declared: the edit that follows refuses it.
          const declarator = scopes.bindingOf(value)?.node;
          const init =
            declarator?.type === 'VariableDeclarator' && declarator.id.type === 'Identifier'
              ? declarator.init
              : undefined;
          if (!init) {
            return undefined;
          }
          enter(value);
          value = unwrapExpression(init);
        } else if (value.type === 'MemberExpression') {
          const key = memberKey(value);
          enter(value);
          const owner = key === undefined ? undefined : objectOf(value.object);
          const held = owner && shapeOf(owner).members.get(key!)?.value;
          if (!held) {
            return undefined;
          }
          value = unwrapExpression(held);
        } else {
          return value;
        }
      }
    } finally {
      for (const value of entered) {
        following.delete(value);
      }
    }
  };

  const objectOf = (node: Node | null | undefined) => {
    const value = follow(node);
    return value?.type === 'ObjectExpression' ? value : undefined;
  };

  // The object a default export holds, also as the argument of a call such as `definePreview(...)`
  // and through `.type<T>()`.
  const configObjectOf = (node: Node | null | undefined) => {
    let value = follow(node);
    const calls = new Set<Node>();
    while (value?.type === 'CallExpression' && !calls.has(value)) {
      calls.add(value);
      const receiver = withoutTypeCalls(value);
      value = follow(receiver === value ? value.arguments[0] : receiver);
    }
    return value?.type === 'ObjectExpression' ? value : undefined;
  };

  const keyOf = (property: E.ObjectProperty): string | undefined => {
    const name = staticKey(property);
    if (name !== undefined) {
      return name;
    }
    const key = property.computed
      ? resolveExpression(scopes, property.key, 'read')
      : (property.key as Node);
    if (key?.type === 'Literal') {
      return 'bigint' in key && typeof key.bigint === 'string'
        ? String(BigInt(key.bigint))
        : String(key.value ?? key.raw);
    }
    return key ? staticKey({ ...property, key } as E.ObjectProperty) : undefined;
  };

  const shapeOf = (object: E.ObjectExpression): Shape => {
    const known = shapes.get(object);
    if (known) {
      return known;
    }
    const shape: Shape = { members: new Map(), computed: [], external: false };
    if (shaping.has(object)) {
      shape.external = true;
      return shape;
    }
    shaping.add(object);
    for (const property of object.properties) {
      if (property.type === 'SpreadElement') {
        const spread = objectOf(property.argument);
        if (!spread) {
          shape.external = true;
          continue;
        }
        const inner = shapeOf(spread);
        // `Map#set` keeps the position a key was first defined at, as an object literal does.
        for (const [key, member] of inner.members) {
          shape.members.set(key, member);
        }
        shape.computed.push(...inner.computed);
        shape.external ||= inner.external;
      } else {
        const key = keyOf(property);
        if (key === undefined) {
          shape.computed.push(property.value);
        } else {
          shape.members.set(key, property);
        }
      }
    }
    shaping.delete(object);
    shapes.set(object, shape);
    return shape;
  };

  const keysOf = (object: E.ObjectExpression): CsfKeys | undefined => {
    if (listing.has(object)) {
      return undefined;
    }
    listing.add(object);
    const shape = shapeOf(object);
    const computed = shape.computed.map((value) => {
      const held = objectOf(value);
      return held && keysOf(held);
    });
    listing.delete(object);
    return { keys: [...shape.members.keys()], computed, external: shape.external };
  };

  let defaultValue: Node | undefined;
  for (const statement of editor.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      defaultValue = statement.declaration as Node;
    } else if (statement.type === 'ExportNamedDeclaration') {
      defaultValue =
        (statement.specifiers.find(({ exported }) => exportedName(exported) === 'default')
          ?.local as Node | undefined) ?? defaultValue;
    } else if (
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'AssignmentExpression' &&
      isModuleExports(statement.expression.left)
    ) {
      defaultValue = statement.expression.right;
    }
  }

  const [first, ...rest] = path;
  if (typeof first !== 'string') {
    return undefined;
  }
  const root = configObjectOf(defaultValue);
  let value: Node | null | undefined = root && shapeOf(root).members.get(first)?.value;
  if (!objectOf(value)) {
    // As the runtime does, a field the default export does not show is read from the named exports.
    // `ConfigFile` collects them with the fields of every other config object it finds, such as a
    // reassigned binding or one of two `module.exports` assignments.
    value = config.getFieldNode([first]);
  }
  for (const segment of rest) {
    const object = objectOf(value);
    const member =
      object && typeof segment === 'string' ? shapeOf(object).members.get(segment) : undefined;
    if (!member) {
      return undefined;
    }
    value = member.value;
  }
  const object = objectOf(value);
  return object && keysOf(object);
};
