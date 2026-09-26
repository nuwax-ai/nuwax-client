/** Public product defaults. Credentials belong to the host environment. */
export default Object.freeze({
  product: Object.freeze({
    appId: 'com.nuwax-ai.nuwax',
    name: 'Nuwax',
    displayName: '女娲Nuwax',
    identifier: 'nuwax',
    feedBase: 'https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron',
    downloadUrl: 'https://nuwax.com',
    portOffset: 1000,
  }),
  frontend: Object.freeze({ port: 3000 }),
  release: Object.freeze({
    repo: 'nuwax-ai/nuwax-client',
    signHost: 'win-pc',
    windowsClientDir: '/c/soddy-git-workspace/nuwax-client',
    signGhPath: '/c/Program Files/GitHub CLI',
    s3Base: 'https://s3.nuwax.com:9443/nuwaclaw/nuwax-electron',
    ossBase: 'https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron',
  }),
});
