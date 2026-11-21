'use client';

import React, { useState, useCallback } from 'react';
import { decodeXdr, hexView, type XdrTreeNode, type DecodedXdr } from '@/utils/xdr-decoder';

export const XdrInspectorWorkbench: React.FC = () => {
  const [base64Input, setBase64Input] = useState('');
  const [decoded, setDecoded] = useState<DecodedXdr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);

  const handleDecode = useCallback(() => {
    if (!base64Input.trim()) {
      setError('Please paste a base64 XDR string');
      return;
    }

    try {
      const result = decodeXdr(base64Input);
      setDecoded(result);
      setError(null);
      setExpandedNodes(new Set(['root']));
      setSelectedNodePath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setDecoded(null);
    }
  }, [base64Input]);

  const toggleNode = useCallback((path: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    setExpandedNodes(newExpanded);
  }, [expandedNodes]);

  const handleGenerateRule = useCallback((node: XdrTreeNode, path: string) => {
    if (!node.isLeaf) return;

    const condition = {
      fieldName: node.key,
      type: node.type,
      value: node.value,
      path,
    };

    const conditionJson = JSON.stringify(condition, null, 2);
    console.log('Generate Rule Condition:', conditionJson);
    
    // Copy to clipboard
    navigator.clipboard.writeText(conditionJson).then(() => {
      alert(`Rule condition copied to clipboard:\n\n${conditionJson}`);
    }).catch(() => {
      alert(`Rule condition (failed to copy):\n\n${conditionJson}`);
    });
  }, []);

  return (
    <div className="w-full h-full flex flex-col gap-4 p-6 bg-slate-50">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-slate-900">XDR Inspector Workbench</h1>
        <p className="text-sm text-slate-600">Paste base64 TransactionEnvelope, TransactionResult, TransactionMeta, or ScVal</p>
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          value={base64Input}
          onChange={(e) => setBase64Input(e.target.value)}
          placeholder="Paste base64 XDR string here..."
          className="w-full h-32 p-3 border border-slate-300 rounded-lg font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleDecode}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition w-fit"
        >
          Decode XDR
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg text-sm">
          {error}
        </div>
      )}

      {decoded && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
          {/* Tree View */}
          <div className="flex flex-col gap-2 min-h-0">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-slate-900">XDR Tree</h2>
              <span className="text-xs bg-slate-200 px-2 py-1 rounded">{decoded.type}</span>
            </div>
            <div className="flex-1 overflow-auto border border-slate-300 rounded-lg bg-white p-3">
              <TreeNode
                node={decoded.tree}
                path="root"
                expanded={expandedNodes}
                onToggle={toggleNode}
                onGenerateRule={handleGenerateRule}
                onSelect={setSelectedNodePath}
                selected={selectedNodePath}
              />
            </div>
          </div>

          {/* Hex Viewer */}
          <div className="flex flex-col gap-2 min-h-0">
            <h2 className="font-bold text-slate-900">Hex Bytes</h2>
            <div className="flex-1 overflow-auto border border-slate-300 rounded-lg bg-slate-900 p-3">
              <pre className="font-mono text-xs text-green-400">
                {hexView(decoded.bytes).map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface TreeNodeProps {
  node: XdrTreeNode;
  path: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onGenerateRule: (node: XdrTreeNode, path: string) => void;
  onSelect: (path: string | null) => void;
  selected: string | null;
}

function TreeNode({
  node,
  path,
  expanded,
  onToggle,
  onGenerateRule,
  onSelect,
  selected,
}: TreeNodeProps) {
  const isExpanded = expanded.has(path);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selected === path;

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer transition ${
          isSelected ? 'bg-blue-100 border-l-2 border-blue-500' : 'hover:bg-slate-100'
        }`}
        onClick={() => {
          onSelect(isSelected ? null : path);
          if (hasChildren) onToggle(path);
        }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(path);
            }}
            className="flex-shrink-0 w-5 text-center"
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="w-5" />
        )}

        <span className="font-mono font-semibold text-slate-700">{node.key}</span>
        <span className="text-slate-500">:</span>
        <span className="text-slate-600">{node.type}</span>

        {node.value !== undefined && (
          <span className="text-slate-900 ml-auto mr-2 truncate max-w-xs">
            {String(node.value).substring(0, 100)}
          </span>
        )}

        {node.isLeaf && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onGenerateRule(node, path);
            }}
            className="flex-shrink-0 text-xs bg-emerald-500 text-white px-2 py-1 rounded hover:bg-emerald-600 transition"
          >
            Rule
          </button>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div className="ml-4 pl-3 border-l border-slate-300">
          {node.children!.map((child, idx) => (
            <TreeNode
              key={`${path}-${idx}`}
              node={child}
              path={`${path}-${idx}`}
              expanded={expanded}
              onToggle={onToggle}
              onGenerateRule={onGenerateRule}
              onSelect={onSelect}
              selected={selected}
            />
          ))}
        </div>
      )}
    </div>
  );
}
