import { LiveServerService } from './live-server';
import { serve } from './transport';
const service = new LiveServerService();
serve(
  (method, params) => {
    switch (method) {
      case 'status':
        return service.status();
      case 'start':
        return service.start(params);
      case 'stop':
        return service.stop();
      case 'open':
        return service.openBrowser();
      default:
        throw new Error('Unsupported Live Server operation.');
    }
  },
  async () => {
    await service.stop();
  },
);
