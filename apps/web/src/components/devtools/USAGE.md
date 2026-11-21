# XDR Inspector Workbench

An interactive XDR workbench for decoding and inspecting Stellar transactions entirely client-side.

## Features

- **Decodes XDR types**: TransactionEnvelope, TransactionResult, TransactionMeta, ScVal
- **Tree hierarchy**: Collapsible view of decoded XDR structure with discriminants, field names, and values
- **Hex byte viewer**: Synchronized hex/ASCII display of raw bytes
- **Rule generation**: One-click 'Generate Rule Condition' on any leaf node to pre-populate alert filters

## Usage

```tsx
import { XdrInspectorWorkbench } from '@/components/devtools/XdrInspectorWorkbench';

export default function Dashboard() {
  return <XdrInspectorWorkbench />;
}
```

## How it Works

1. **Paste XDR**: Paste a base64-encoded XDR string into the textarea
2. **Decode**: Click "Decode XDR" button
3. **Explore**: Expand/collapse tree nodes to inspect structure
4. **Generate Rules**: Click "Rule" on any leaf node to generate a rule condition

## Utility Functions

### decodeXdr(base64String: string): DecodedXdr

Decodes any base64 XDR string and returns:
- `type`: Detected XDR type (TransactionEnvelope, etc.)
- `tree`: Parsed AST tree structure
- `bytes`: Raw decoded bytes
- `base64`: Original input

```tsx
import { decodeXdr } from '@/utils/xdr-decoder';

const result = decodeXdr(base64String);
// result.tree contains the hierarchical structure
// result.bytes contains raw bytes for hex viewer
```

### hexView(bytes: Uint8Array, width?: number): string[]

Generates formatted hex/ASCII output for byte viewing:

```tsx
import { hexView } from '@/utils/xdr-decoder';

const lines = hexView(bytes, 16);
// Each line: "00000000  48 65 6c 6c 6f ...  Hello ..."
```

## Tree Node Structure

Each node in the decoded tree has:
- `key`: Field name
- `type`: XDR type name
- `value`: Decoded value (for leaf nodes)
- `isLeaf`: Whether this is a terminal node
- `children`: Child nodes (if expandable)
- `discriminant`: Union type discriminant (if applicable)

## Example: Using Decoded Data

```tsx
const { tree, bytes, type } = decodeXdr(myXdr);

// Access structure
console.log(tree.type); // "TransactionEnvelope"
console.log(tree.children?.[0]); // First child node

// Traverse tree recursively
function traverse(node) {
  if (node.isLeaf) {
    console.log(`${node.key}: ${node.value}`);
  } else {
    node.children?.forEach(traverse);
  }
}

traverse(tree);
```

## Integration Points

The workbench can integrate with alert rule builders:

```tsx
// When user clicks "Rule" on a node:
const ruleCondition = {
  fieldName: node.key,
  type: node.type,
  value: node.value,
  path: nodePath // Full path in tree
};

// Pre-populate alert rule builder
useAlertBuilder(ruleCondition);
```
