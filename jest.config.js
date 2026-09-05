// Root Jest config. Each mock keeps its specs next to its source; nothing here is collected for
// SonarQube coverage because the mocks are not production code (PLAT-2919).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/lib', '<rootDir>/keystone-idp-mock', '<rootDir>/bedrock-core-mock',
    '<rootDir>/aggregio-mock', '<rootDir>/tickerhaus-mock', '<rootDir>/triscore-mock',
    '<rootDir>/paylink-network-mock', '<rootDir>/vault-mock', '<rootDir>/splunk-hec-mock',
    '<rootDir>/lantern-collector-mock', '<rootDir>/semaphore-flags-mock', '<rootDir>/ldap-mock'],
  testMatch: ['**/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }] },
  moduleNameMapper: { '^@meridian/mock-kit$': '<rootDir>/lib/mock-kit/src/index.ts' }
};
