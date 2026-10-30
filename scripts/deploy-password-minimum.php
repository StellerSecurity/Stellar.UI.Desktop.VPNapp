<?php
declare(strict_types=1);
// First-party two-file staging overlay. Never reads credentials or touches accounts.
ini_set('display_errors', '0');
$root='/home/site/wwwroot'; $changed=[]; $backup=null;
try {
    if (PHP_SAPI!=='cli' || strtolower((string)getenv('WEBSITE_SITE_NAME'))!=='stellar-desktop-vpn-staging-premium') throw new LogicException('wrong_site');
    $lock=fopen('/home/stellar-redemption-deployment.lock','c');
    if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) throw new LogicException('deployment_busy');
    $payload=json_decode(file_get_contents(__DIR__.'/payload.json'),true,16,JSON_THROW_ON_ERROR);
    $paths=['app/Application/AuthService.php','app/Infrastructure/UserApiIdentityGateway.php'];
    if(array_keys($payload)!==$paths) throw new LogicException('unexpected_files');
    foreach($paths as $path){
        $target=$root.'/'.$path; $file=$payload[$path];
        if(is_link($target)||hash_file('sha256',$target)!==$file['before']) throw new LogicException('baseline_changed');
        $source=base64_decode($file['content'],true);
        if(!is_string($source)||hash('sha256',$source)!==$file['after']) throw new LogicException('payload_changed');
        $temp=__DIR__.'/'.basename($path);file_put_contents($temp,$source);
        exec(escapeshellarg(PHP_BINARY).' -l '.escapeshellarg($temp).' 2>&1',$out,$status);
        if($status!==0)throw new LogicException('invalid_php');
    }
    $backup='/home/stellar-password-policy-backup-'.gmdate('Ymd-His').'-'.bin2hex(random_bytes(4));
    if(!mkdir($backup,0700))throw new RuntimeException('backup_failed');
    foreach($paths as $path){if(!copy($root.'/'.$path,$backup.'/'.basename($path)))throw new RuntimeException('backup_failed');chmod($backup.'/'.basename($path),0600);}
    foreach($paths as $path){
        $target=$root.'/'.$path;$temp=tempnam(dirname($target),'.stellar-password-');
        if(!$temp||!copy(__DIR__.'/'.basename($path),$temp)||!chmod($temp,0644)||!rename($temp,$target))throw new RuntimeException('publish_failed');
        $changed[]=$path;
    }
    foreach($paths as $path)if(hash_file('sha256',$root.'/'.$path)!==$payload[$path]['after'])throw new RuntimeException('verification_failed');
    echo 'STELLAR_PASSWORD_POLICY_DEPLOYED '.json_encode(['site'=>'stellar-desktop-vpn-staging-premium','minimum'=>6,'files'=>2,'backup'=>$backup]).PHP_EOL;
}catch(Throwable $error){foreach($changed as $path)copy($backup.'/'.basename($path),$root.'/'.$path);echo 'STELLAR_PASSWORD_POLICY_FAILED '.get_class($error).PHP_EOL;exit(1);}
