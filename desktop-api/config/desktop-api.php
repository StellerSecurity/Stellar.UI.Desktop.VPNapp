<?php
return [
    'mode' => env('STELLAR_API_MODE', 'disabled'),
    'azure_site' => env('WEBSITE_SITE_NAME'),
    'identity' => env('STELLAR_IDENTITY_MODE', 'disabled'),
    // Azure reserves APPSETTING_ for platform aliases; configure canonical API_ keys.
    'user_service_username' => env('API_USERNAME_STELLAR_USER_API', env('APPSETTING_API_USERNAME_STELLAR_USER_API')),
    'user_service_password' => env('API_PASSWORD_STELLAR_USER_API', env('APPSETTING_API_PASSWORD_STELLAR_USER_API')),
];
