import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SankeyFlowDiagram } from './SankeyFlowDiagram';
import type { PathPaymentFlow } from './sankeyLayout';
import { SAMPLE_PATH_PAYMENT_FLOWS } from './sankeySampleData';

const TWO_HOP: PathPaymentFlow = {
  id: 'flow-a',
  txHash: 'abc123',
  ledger: 42,
  sourceAsset: 'XLM',
  sourceAmount: 10000,
  destinationAsset: 'EURC',
  destinationAmount: 2238.75,
  hops: [
    {
      poolId: 'xlm-usdc',
      poolLabel: 'XLM/USDC',
      fromAsset: 'XLM',
      fromAmount: 10000,
      toAsset: 'USDC',
      toAmount: 2450,
      feeAsset: 'XLM',
      feeAmount: 5,
    },
    {
      poolId: 'usdc-eurc',
      poolLabel: 'USDC/EURC',
      fromAsset: 'USDC',
      fromAmount: 2450,
      toAsset: 'EURC',
      toAmount: 2238.75,
      feeAsset: 'USDC',
      feeAmount: 1.225,
    },
  ],
};

const ONE_HOP: PathPaymentFlow = {
  id: 'flow-b',
  sourceAsset: 'XLM',
  sourceAmount: 5000,
  destinationAsset: 'USDC',
  destinationAmount: 1225,
  hops: [
    {
      poolId: 'xlm-usdc',
      poolLabel: 'XLM/USDC',
      fromAsset: 'XLM',
      fromAmount: 5000,
      toAsset: 'USDC',
      toAmount: 1225,
      feeAsset: 'XLM',
      feeAmount: 2.5,
    },
  ],
};

const ribbons = () => screen.getAllByTestId('sankey-ribbon');
const fillOpacities = () => ribbons().map((node) => node.getAttribute('fill-opacity'));
const nodeRoles = () =>
  screen.getAllByTestId('sankey-node').map((node) => node.getAttribute('data-node-role'));
const ribbonsFor = (flowId: string) =>
  ribbons().filter((node) => node.getAttribute('data-flow-id') === flowId);

describe('SankeyFlowDiagram', () => {
  it('shows an empty state with a sample preview when no routes exist', () => {
    render(<SankeyFlowDiagram flows={[]} />);

    expect(screen.getByTestId('sankey-empty-state')).toBeInTheDocument();
    expect(screen.getByText('No multi-hop path payment routes recorded yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('sankey-svg')).not.toBeInTheDocument();
  });

  it('renders the sample route after the preview is requested', async () => {
    const user = userEvent.setup();
    render(<SankeyFlowDiagram flows={[]} />);

    await user.click(screen.getByTestId('sankey-load-sample'));

    expect(screen.queryByTestId('sankey-empty-state')).not.toBeInTheDocument();
    expect(screen.getByTestId('sankey-svg')).toBeInTheDocument();
    expect(screen.getByText('Sample route data')).toBeInTheDocument();
    expect(nodeRoles().filter((role) => role === 'source')).toHaveLength(2);
    expect(nodeRoles().filter((role) => role === 'pool')).toHaveLength(3);
    expect(nodeRoles().filter((role) => role === 'destination')).toHaveLength(3);
  });

  it('returns to the empty state when the sample preview is exited', async () => {
    const user = userEvent.setup();
    render(<SankeyFlowDiagram flows={[]} />);

    await user.click(screen.getByTestId('sankey-load-sample'));
    await user.click(screen.getByTestId('sankey-clear-sample'));

    expect(screen.getByTestId('sankey-empty-state')).toBeInTheDocument();
  });

  it('draws one ribbon per conversion step plus a settlement ribbon', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP]} />);

    expect(ribbons()).toHaveLength(3);
    expect(nodeRoles()).toEqual(['source', 'pool', 'pool', 'destination']);
  });

  it('lists every hop with its pool, amounts, and fee rate', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP]} />);

    const rows = screen.getAllByTestId('sankey-hop-row');
    expect(rows).toHaveLength(2);

    const [firstHop, secondHop] = rows;
    expect(within(firstHop).getByText('XLM/USDC')).toBeInTheDocument();
    expect(within(firstHop).getByText(/10,000\.00 XLM/)).toBeInTheDocument();
    expect(within(firstHop).getByText(/2,450\.00 USDC/)).toBeInTheDocument();
    expect(within(firstHop).getByText(/5\.00 XLM/)).toBeInTheDocument();
    expect(within(firstHop).getByText('5.0 bps')).toBeInTheDocument();

    expect(within(secondHop).getByText('USDC/EURC')).toBeInTheDocument();
    expect(within(secondHop).getByText(/1\.225 USDC/)).toBeInTheDocument();
    expect(within(secondHop).getByText('5.0 bps')).toBeInTheDocument();
  });

  it('summarises route count, hop count, and per-asset fees', () => {
    render(<SankeyFlowDiagram flows={SAMPLE_PATH_PAYMENT_FLOWS} />);

    const summary = screen.getByTestId('sankey-summary');
    expect(summary).toHaveTextContent('3 paths · 4 hops');
    expect(summary).toHaveTextContent('7.50 XLM fees');
    expect(summary).toHaveTextContent('1.725 USDC fees');
  });

  it('isolates the hovered route and dims the ribbons of other routes', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    expect(fillOpacities().every((value) => value === '0.75')).toBe(true);

    fireEvent.mouseOver(ribbonsFor('flow-a')[0]);

    expect(ribbonsFor('flow-a').every((node) => node.getAttribute('fill-opacity') === '0.9')).toBe(
      true,
    );
    expect(
      ribbonsFor('flow-b').every((node) => node.getAttribute('fill-opacity') === '0.1'),
    ).toBe(true);
  });

  it('restores every ribbon when the pointer leaves the diagram', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    fireEvent.mouseOver(ribbonsFor('flow-a')[0]);
    fireEvent.mouseOut(ribbonsFor('flow-a')[0]);

    expect(fillOpacities().every((value) => value === '0.75')).toBe(true);
  });

  it('highlights a route when one of its ribbons receives keyboard focus', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    fireEvent.focusIn(ribbonsFor('flow-a')[0]);

    expect(ribbonsFor('flow-b').every((node) => node.getAttribute('fill-opacity') === '0.1')).toBe(
      true,
    );
  });

  it('dims the ribbons that do not touch the hovered DEX pool node', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    const poolNode = screen
      .getAllByTestId('sankey-node')
      .find((node) => node.getAttribute('data-node-role') === 'pool')!;
    const poolShape = poolNode.querySelector('rect')!;

    fireEvent.mouseOver(poolShape);
    expect(
      ribbonsFor('flow-a').some((node) => node.getAttribute('fill-opacity') === '0.1'),
    ).toBe(true);

    fireEvent.mouseOut(poolShape);
    expect(fillOpacities().every((value) => value === '0.75')).toBe(true);
  });

  it('pins a route on click and clears it with the reset control', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    fireEvent.click(ribbonsFor('flow-a')[0]);
    expect(ribbonsFor('flow-a')[0]).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('sankey-reset'));

    expect(ribbonsFor('flow-a')[0]).toHaveAttribute('aria-pressed', 'false');
    expect(fillOpacities().every((value) => value === '0.75')).toBe(true);
  });

  it('toggles a route pin from the keyboard', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    fireEvent.keyDown(ribbonsFor('flow-a')[0], { key: 'Enter' });
    expect(ribbonsFor('flow-a')[0]).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(ribbonsFor('flow-a')[0], { key: ' ' });
    expect(ribbonsFor('flow-a')[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears the active route when Escape is pressed', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    fireEvent.mouseOver(ribbonsFor('flow-a')[0]);
    expect(screen.getByTestId('sankey-reset')).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByTestId('sankey-reset')).not.toBeInTheDocument();
    expect(fillOpacities().every((value) => value === '0.75')).toBe(true);
  });

  it('narrows the diagram to a single route from the selector', async () => {
    const user = userEvent.setup();
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    expect(ribbons()).toHaveLength(5);

    await user.selectOptions(screen.getByTestId('sankey-flow-select'), 'flow-b');

    expect(ribbons()).toHaveLength(2);
    expect(ribbons().every((node) => node.getAttribute('data-flow-id') === 'flow-b')).toBe(true);
  });

  it('resets the selector back to all routes after a reset', async () => {
    const user = userEvent.setup();
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    await user.selectOptions(screen.getByTestId('sankey-flow-select'), 'flow-b');
    fireEvent.click(ribbons()[0]);

    fireEvent.click(screen.getByTestId('sankey-reset'));

    expect(screen.getByTestId('sankey-flow-select')).toHaveValue('all');
    expect(ribbons()).toHaveLength(5);
  });

  it('switches ribbon sizing from traded amount to hop fees', async () => {
    const user = userEvent.setup();
    render(<SankeyFlowDiagram flows={[TWO_HOP, ONE_HOP]} />);

    expect(screen.getByTestId('sankey-metric-amount')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Ribbon width is scaled to traded amount.')).toBeInTheDocument();

    await user.click(screen.getByTestId('sankey-metric-fee'));

    expect(screen.getByTestId('sankey-metric-fee')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sankey-metric-amount')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Ribbon width is scaled to hop fee size.')).toBeInTheDocument();
    expect(ribbons()).toHaveLength(5);
  });

  it('describes every ribbon for assistive technology', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP]} />);

    expect(
      screen.getByLabelText('Hop 1 into XLM/USDC: 10,000.00 XLM, fee 5.00 XLM'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Hop 2 into USDC/EURC: 2,450.00 USDC, fee 1.225 USDC'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Settlement of 2,238.75 EURC into EURC')).toBeInTheDocument();
  });

  it('notes a route without conversion hops in the breakdown table', () => {
    render(
      <SankeyFlowDiagram
        flows={[
          {
            id: 'direct',
            sourceAsset: 'XLM',
            sourceAmount: 10,
            destinationAsset: 'XLM',
            destinationAmount: 10,
          },
        ]}
      />,
    );

    expect(screen.getByTestId('sankey-direct-row')).toBeInTheDocument();
    expect(screen.getByText('Direct transfer, no conversion hops.')).toBeInTheDocument();
    expect(ribbons()).toHaveLength(1);
  });

  it('renders a loading state instead of the diagram', () => {
    render(<SankeyFlowDiagram flows={[TWO_HOP]} isLoading />);

    expect(screen.getByText('Loading path payment routes...')).toBeInTheDocument();
    expect(screen.queryByTestId('sankey-svg')).not.toBeInTheDocument();
  });
});
