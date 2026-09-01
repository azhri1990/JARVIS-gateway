// Shared types for the J.A.R.V.I.S gateway.

export type DeviceType = 'phone' | 'laptop' | 'tablet'

export interface PairRequest {
  deviceName: string
  deviceType: DeviceType
  secret?: string
}

export interface PairResponse {
  pairingToken: string
  sessionKey: string
  ttlSeconds: number
}

export interface Session {
  key: string
  deviceName: string
  deviceType: DeviceType
  createdAt: number
}
