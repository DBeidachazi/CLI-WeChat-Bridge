## Test Layout

- `test/bridge`: bridge lifecycle, adapters, lock state, reply formatting, and hook behavior
- `test/companion`: local companion launcher behavior
- `test/wechat`: WeChat transport and workspace channel config

## Commands

- `npm test`: run the full test suite under `test/`
- `npm run test:bridge`: run only bridge tests
- `npm run test:companion`: run only companion tests
- `npm run test:wechat`: run only WeChat tests
- `npm run test:watch`: watch the dedicated `test/` tree
