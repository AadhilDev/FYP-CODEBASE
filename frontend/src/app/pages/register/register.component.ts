import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import * as sss from 'shamirs-secret-sharing';
import { Buffer } from 'buffer';
import { last } from 'rxjs';
import { getDeviceFingerprint, hashValue } from '../../shared/utils/crypto-utils';

@Component({
  selector: 'app-register',
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.css']
})
export class RegisterComponent {
  user = { 
    name: '', 
    email: '', 
    password: '', 
    password2: '' 
  };
  loading = false;

  constructor(
    private http: HttpClient, 
    private router: Router
  ) {}

  async register() {
    if (!this.user.name || !this.user.email || !this.user.password || !this.user.password2) {
      alert('All fields are required.');
      return;
    }

    // Corrected password matching validation
    if (this.user.password === this.user.password2) {
      alert('Passwords should not match.');
      return;
    }
    
    this.loading = true;
    
    try {
      // 1. Generate Ethereum Wallet
      const wallet = await this.generateWallet();

      // 2. Generate ZKP-specific elements
      const userSalt = await this.generateRandomFieldElement();
      const deviceId = await getDeviceFingerprint();

      // 4. Encrypt the private key using the password
      const encryptedPrivateKey = await this.encryptPrivateKey(wallet.privateKey, this.user.password);
      
      // 5. Split the encrypted private key into 5 shares with threshold 4
      const shares = await this.splitSecret(encryptedPrivateKey, 5, 4);
      
      // Convert Buffer shares to Base64 strings for JSON storage
      const sharesBase64 = shares.map(share => Buffer.from(share).toString('base64'));

      const crypto = await import('crypto-js');
      const userShard = crypto.AES.encrypt(sharesBase64[0], this.user.password);
      
      // 3. Generate ZKP identity commitments
      const usernameHash = await hashValue(this.user.name);
      const saltCommitment = await hashValue(this.user.name + userSalt);
      const identityCommitment = await hashValue(sharesBase64[0] + userSalt);
      const deviceCommitment = await hashValue(identityCommitment + deviceId);
      
      // 6. Send registration data to server
      const registrationData = {
        name: this.user.name,
        email: this.user.email,
        password: this.user.password,
        password2: this.user.password2,
        walletAddress: wallet.address,
        publicKey: wallet.publicKey,
        // ZKP-specific data
        usernameHash: usernameHash,
        saltCommitment: saltCommitment,
        identityCommitment: identityCommitment,
        deviceCommitment: deviceCommitment,
        lastAuthTimestamp: new Date().toISOString().replace('Z', '+00:00')
        //maxAuthLevel: 10 // Default max auth level
      };

      console.log("Registration data:", registrationData);

      this.http.post('http://localhost:5010/api/auth/register', registrationData)
        .subscribe({
          next: async (response) => {
            // 7. Create and download JSON file with shares and ZKP inputs
            const jsonContent = JSON.stringify({
              //shares from index 1 to 4
              shares: sharesBase64.slice(1),
              walletAddress: wallet.address,
              threshold: 4,
              totalShares: 5,
              // ZKP input data for login
              privateKey: wallet.privateKey,
              userSalt: userSalt,
              deviceId: deviceId
            }, null, 2);

            const blob = new Blob([jsonContent], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            
            // Create download link and trigger click
            const a = document.createElement('a');
            a.href = url;
            a.download = 'wallet-zkp-shares.json';
            document.body.appendChild(a);
            a.click();
            
            // Cleanup
            setTimeout(() => {
              document.body.removeChild(a);
              window.URL.revokeObjectURL(url);
            }, 0);

            alert('Registration successful! Your wallet information has been split into 5 shares (threshold: 4) and downloaded as wallet-zkp-shares.json. Please store this file securely.');

            localStorage.setItem('userShard', userShard.toString());
            // Redirect to login
            this.router.navigate(['/login']);
          },
          error: (err) => {
            alert('Error: ' + (err.error?.message || 'Registration failed'));
          }
        });

    } catch (error) {
      console.error("Registration error:", error);
      alert("Registration failed. Please try again.");
    } finally {
      this.loading = false;
    }
  }

  // Generate a random field element for ZKP using browser's crypto API
  private async generateRandomFieldElement(): Promise<string> {
    const array = new Uint8Array(31); // 31 bytes to ensure it's smaller than field size
    window.crypto.getRandomValues(array);
    return '0x' + Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // // Get device fingerprint using browser information
  // private async getDeviceFingerprint(): Promise<string> {
  //   const screenInfo = `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`;
  //   const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  //   const language = navigator.language;
  //   const userAgent = navigator.userAgent;
    
  //   return await this.hashValue(screenInfo + timeZone + language + userAgent);
  // }

  // // Hash a value using browser's native crypto API
  // private async hashValue(value: string): Promise<string> {
  //   const encoder = new TextEncoder();
  //   const data = encoder.encode(value);
  //   const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  //   const hashArray = Array.from(new Uint8Array(hashBuffer));
  //   const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  //   return '0x' + hashHex;
  // }

  private async generateWallet() {
    const ethers = await import('ethers');
    const wallet = ethers.Wallet.createRandom();
    return {
      privateKey: wallet.privateKey,
      publicKey: wallet.publicKey,
      address: wallet.address
    };
  }

  private async encryptPrivateKey(privateKey: string, password: string): Promise<string> {
    const ethers = await import('ethers');
    const wallet = new ethers.Wallet(privateKey);
    
    // Encrypt the wallet using the password
    const encryptedWallet = await wallet.encrypt(password);
    
    return encryptedWallet;
  }

  private async splitSecret(secret: string, numShares: number, threshold: number): Promise<Uint8Array[]> {
    // Convert the string to Buffer
    const secretBuffer = Buffer.from(secret, 'utf8');
    
    // Generate the shares
    const shares = sss.split(secretBuffer, { shares: numShares, threshold: threshold });
    
    return shares;
  }

  private async combineShares(shares: Uint8Array[]): Promise<string> {
    // Combine the shares to reconstruct the secret
    const recoveredBuffer = sss.combine(shares);
    
    // Convert Buffer back to string
    return recoveredBuffer.toString('utf8');
  }

  // Method to reconstruct and decrypt private key
  public async reconstructAndDecryptPrivateKey(sharesBase64: string[], password: string): Promise<string> {
    // Ensure we have at least 4 shares
    if (sharesBase64.length < 4) {
      throw new Error('At least 4 shares are required to reconstruct the private key');
    }
    try {
      // Convert base64 shares back to Uint8Array
      const shares = sharesBase64.map(share => Buffer.from(share, 'base64'));
      
      // Combine shares to get the encrypted wallet JSON
      const encryptedJson = await this.combineShares(shares);
      
      // Decrypt the wallet using the password
      const ethers = await import('ethers');
      const wallet = await ethers.Wallet.fromEncryptedJson(encryptedJson, password);
      
      return wallet.privateKey;
    } catch (error) {
      console.error('Error reconstructing or decrypting private key:', error);
      throw new Error('Failed to reconstruct or decrypt private key');
    }
  }
}