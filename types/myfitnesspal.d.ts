declare module 'myfitnesspal' {
  export class MFPClient {
    IDTokenResponse: {
      access_token: string;
      refresh_token: string;
      id_token: string;
      token_type: string;
      expires_in: number;
    };
    constructor(username: string, password: string);
    initialLoad(): Promise<void>;
  }
}
