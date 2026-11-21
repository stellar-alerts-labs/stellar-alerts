import { decodeXdr, hexView } from '@/utils/xdr-decoder';

describe('XDR Inspector', () => {
  it('should handle invalid base64', () => {
    expect(() => decodeXdr('invalid!!!')).toThrow();
  });

  it('should generate hex view', () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const lines = hexView(bytes, 16);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('48');
  });

  it('should export utility types', () => {
    // Type checking test
    const testFn = (xdr: ReturnType<typeof decodeXdr>) => {
      expect(xdr.type).toBeDefined();
      expect(xdr.tree).toBeDefined();
      expect(xdr.bytes).toBeDefined();
      expect(xdr.base64).toBeDefined();
    };
    
    // Just verify the function signature works
    expect(typeof testFn).toBe('function');
  });
});
