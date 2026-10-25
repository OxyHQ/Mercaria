import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { type CredentialStorage, webCredentialStorage } from './commerce-credential';

export function commerceStorage(key: string): CredentialStorage {
  return Platform.OS === 'web'
    ? webCredentialStorage(key)
    : {
        read: () => SecureStore.getItemAsync(key),
        write: (value) => SecureStore.setItemAsync(key, value),
        remove: () => SecureStore.deleteItemAsync(key),
      };
}
