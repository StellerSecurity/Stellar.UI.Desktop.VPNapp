<?php
return [
    // Enable only after BOTH receipt/credit API upgrades and migrations are deployed.
    'activation_enabled' => env('STELLAR_ACTIVATION_ENABLED', false),
    'activation_service_username' => env('API_USERNAME_STELLAR_ACTIVATIONLICENSE_API', env('APPSETTING_API_USERNAME_STELLAR_ACTIVATIONLICENSE_API')),
    'activation_service_password' => env('API_PASSWORD_STELLAR_ACTIVATIONLICENSE_API', env('APPSETTING_API_PASSWORD_STELLAR_ACTIVATIONLICENSE_API')),
    // Separate opt-in; existing sign-in/account integrations remain unchanged by default.
    'vpn_login' => env('STELLAR_VPN_LOGIN_ENABLED', false),
    'vpn_service_username' => env('STELLAR_VPN_USERNAME', env('APPSETTING_STELLAR_VPN_USERNAME')),
    'vpn_service_password' => env('STELLAR_VPN_PASSWORD', env('APPSETTING_STELLAR_VPN_PASSWORD')),
    'mode' => env('STELLAR_API_MODE', 'disabled'),
    'azure_site' => env('WEBSITE_SITE_NAME'),
    'identity' => env('STELLAR_IDENTITY_MODE', 'disabled'),
    'subscription_service_username' => env('API_USERNAME_STELLER_SUBSCRIPTION_API', env('APPSETTING_API_USERNAME_STELLER_SUBSCRIPTION_API')),
    'subscription_service_password' => env('API_PASSWORD_STELLER_SUBSCRIPTION_API', env('APPSETTING_API_PASSWORD_STELLER_SUBSCRIPTION_API')),
    'device_service_username' => env('API_USERNAME_STELLAR_DEVICE_API', env('APPSETTING_API_USERNAME_STELLAR_DEVICE_API')),
    'device_service_password' => env('API_PASSWORD_STELLAR_DEVICE_API', env('APPSETTING_API_PASSWORD_STELLAR_DEVICE_API')),
    // Azure reserves APPSETTING_ for platform aliases; configure canonical API_ keys.
    'user_service_username' => env('API_USERNAME_STELLAR_USER_API', env('APPSETTING_API_USERNAME_STELLAR_USER_API')),
    'user_service_password' => env('API_PASSWORD_STELLAR_USER_API', env('APPSETTING_API_PASSWORD_STELLAR_USER_API')),
];
