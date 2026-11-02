import { describe, expect, it } from 'vitest';
import { publicWebUrl } from './publicWebUrl';
describe('public gateway links', () => {
  const context = { businessOrigin: 'https://business.example', gatewayOrigin: 'http://127.0.0.1:45678' };
  it('maps only the configured gateway and keeps path/query/hash without credentials', () => {
    expect(publicWebUrl('http://127.0.0.1:45678/repo/doc/one?hide_sheet=true&_shell=1#s', context)).toBe('https://business.example/repo/doc/one?hide_sheet=true#s');
    expect(publicWebUrl('http://127.0.0.1:45678//other.example/doc', context)).toBe('https://business.example//other.example/doc');
    expect(publicWebUrl('https://external.example/doc', context)).toBe('https://external.example/doc');
  });
  it('never exports a gateway without its business mapping or embedded credentials', () => {
    expect(publicWebUrl('http://127.0.0.1:45678/repo/doc/one', { gatewayOrigin: context.gatewayOrigin })).toBeNull();
    expect(publicWebUrl('https://user:secret@business.example/doc', context)).toBeNull();
    expect(publicWebUrl('file:///private', context)).toBeNull();
  });
});
