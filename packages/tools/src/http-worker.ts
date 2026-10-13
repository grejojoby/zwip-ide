import { HttpService, type HttpInput } from './http';
import { serve, string } from './transport';
const service = new HttpService();
serve(
  (method, params) => {
    switch (method) {
      case 'execute':
        return service.execute(params as unknown as HttpInput);
      case 'cancel':
        return service.cancel(string(params, 'id'));
      default:
        throw new Error('Unsupported HTTP operation.');
    }
  },
  () => service.dispose(),
);
