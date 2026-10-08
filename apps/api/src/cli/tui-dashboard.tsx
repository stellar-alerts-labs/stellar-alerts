#!/usr/bin/env tsx
import React, { useState, useEffect } from 'react';
import { render, Text, Box, Newline } from 'ink';
import Table from 'ink-table';
import { redis } from '../lib/redis';

interface Payment {
  id: string;
  walletId: string;
  fromAddress: string;
  amount: string;
  asset: string;
  receivedAt: string;
}

interface QueueMetrics {
  waiting: number;
  active: number;
  delayed: number;
}

interface SystemMetrics {
  queueDepth: QueueMetrics;
  deliveryLatency: number;
  workerStatus: string;
}

const TuiDashboard: React.FC = () => {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [metrics, setMetrics] = useState<SystemMetrics>({
    queueDepth: { waiting: 0, active: 0, delayed: 0 },
    deliveryLatency: 0,
    workerStatus: 'idle',
  });
  const [lastUpdate, setLastUpdate] = useState<string>(new Date().toISOString());

  useEffect(() => {
    const pubsub = redis.duplicate();

    pubsub.subscribe('payments', 'system_metrics');

    pubsub.on('message', (channel: string, message: string) => {
      if (channel === 'payments') {
        const payment = JSON.parse(message);
        setPayments((prev) => [payment, ...prev].slice(0, 10));
      } else if (channel === 'system_metrics') {
        const data = JSON.parse(message);
        setMetrics(data);
      }
      setLastUpdate(new Date().toISOString());
    });

    return () => {
      pubsub.quit();
    };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="green">
          Stellar Alerts - Real-Time Dashboard
        </Text>
      </Box>
      <Newline />
      <Box>
        <Text dimColor>Last Update: {lastUpdate}</Text>
      </Box>
      <Newline />
      
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">System Metrics</Text>
        <Box>
          <Text>Queue Depth: </Text>
          <Text color="yellow">Waiting: {metrics.queueDepth.waiting}</Text>
          <Text> | </Text>
          <Text color="green">Active: {metrics.queueDepth.active}</Text>
          <Text> | </Text>
          <Text color="red">Delayed: {metrics.queueDepth.delayed}</Text>
        </Box>
        <Box>
          <Text>Delivery Latency: </Text>
          <Text color="magenta">{metrics.deliveryLatency.toFixed(2)}ms</Text>
        </Box>
        <Box>
          <Text>Worker Status: </Text>
          <Text color={metrics.workerStatus === 'active' ? 'green' : 'red'}>
            {metrics.workerStatus}
          </Text>
        </Box>
      </Box>
      
      <Newline />
      <Box flexDirection="column">
        <Text bold color="cyan">Recent Payments (Last 10)</Text>
        {payments.length > 0 ? (
          <Table
            data={payments.map((p) => ({
              ID: p.id.slice(0, 8),
              Wallet: p.walletId.slice(0, 8),
              From: p.fromAddress.slice(0, 8),
              Amount: `${p.amount} ${p.asset}`,
              Time: new Date(p.receivedAt).toLocaleTimeString(),
            }))}
          />
        ) : (
          <Text dimColor>No payments received yet...</Text>
        )}
      </Box>
      
      <Newline />
      <Box>
        <Text dimColor>Press Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
};

if (require.main === module) {
  render(<TuiDashboard />);
}

export default TuiDashboard;
