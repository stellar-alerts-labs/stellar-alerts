import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useWallets } from './useDashboardQueries';

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { accessToken: 'test-access-token', user: { id: 'test-user' } },
  }),
}));

describe('dashboard SWR queries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('revalidates the wallet query when mutate is called', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: async () => ({ success: true, wallets: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    );
    const { result } = renderHook(() => useWallets(), { wrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.mutate();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toContain('/wallets');
  });
});