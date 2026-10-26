module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/dist/tests/**/*.test.js'],
  transform: {},
  collectCoverageFrom: ['dist/src/**/*.js', '!dist/src/demo.js'],
  coverageDirectory: 'coverage',
  testTimeout: 10000
};
