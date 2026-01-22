# User Area Wireframe & Functionality

## Overview
The user area provides account management, channel management, and broadcasting controls.

## Layout Structure

```
┌─────────────────────────────────────────────────────────┐
│  🎙️ Broadcast                    [⚙️ Settings] [Logout] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  My Channels                                      │  │
│  │  ┌────────────────────────────────────────────┐   │  │
│  │  │ 📻 My Awesome Stream                      │   │  │
│  │  │    Description of the stream...           │   │  │
│  │  │    [Go Live]                              │   │  │
│  │  └────────────────────────────────────────────┘   │  │
│  │  ┌────────────────────────────────────────────┐   │  │
│  │  │ 📻 Another Channel                        │   │  │
│  │  │    [Go Live]                              │   │  │
│  │  └────────────────────────────────────────────┘   │  │
│  │                                                    │  │
│  │  [+ Create New Channel]                          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Settings Panel

```
┌─────────────────────────────────────────────────────────┐
│  Account Settings                              [Close]   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Account Information                              │  │
│  │  Email: user@example.com                         │  │
│  │  Member since: Jan 1, 2024                       │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Change Password                                  │  │
│  │  Current Password: [________________]            │  │
│  │  New Password:     [________________]            │  │
│  │  Confirm Password: [________________]            │  │
│  │  [Change Password]                               │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  ⚠️ Danger Zone                                   │  │
│  │  Delete Account                                   │  │
│  │  This will permanently delete your account...    │  │
│  │  Password: [________________]                    │  │
│  │  [Delete My Account]                             │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Features Implemented

### ✅ Security
- **Password Validation**: 
  - Minimum 8 characters
  - Must contain uppercase, lowercase, number, and special character
  - Maximum 128 characters
- **Email Validation**: Proper email format check
- **Password Hashing**: Using bcryptjs (10 rounds)

### ✅ User Management
- **Logout**: Clears session and redirects to login
- **Change Password**: Requires current password verification
- **Delete Account**: Requires password confirmation, deletes all user data
- **User Profile**: Shows email and account creation date

### ✅ Email Notifications
- **Welcome Email**: Sent on registration
- **Password Changed**: Sent when password is updated
- **Account Deleted**: Sent when account is deleted

### 📧 Email Configuration

To enable email notifications, add these environment variables in Railway (API service):

```
SMTP_HOST=smtp.gmail.com (or your SMTP server)
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@yourdomain.com (optional)
```

**Note**: If email is not configured, the system will log what emails would be sent but won't fail.

## UI Components

### Navigation Bar
- Settings button (⚙️) - Opens settings panel
- Logout button - Logs out user

### Settings Panel Sections
1. **Account Information**: Display-only user info
2. **Change Password**: Form with current/new/confirm fields
3. **Danger Zone**: Delete account with password confirmation

### Status Messages
- Success messages (green)
- Error messages (red)
- Info messages (blue)

## User Flow

1. **Login/Register** → Main Dashboard
2. **Main Dashboard** → View channels, create channels, go live
3. **Settings** → Manage account, change password, delete account
4. **Logout** → Returns to login screen
