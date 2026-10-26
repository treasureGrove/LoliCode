<?php
// CLI-only fixture helper. Never deploy into the public web root.
$input = json_decode(stream_get_contents(STDIN), true, 32, JSON_THROW_ON_ERROR);
$site = require '/var/www/forum/site.php';
$site->bootApp();
$name = $input['name'] ?? '';
if (!preg_match('/^relaytest[a-f0-9]{12}(r)?$/D', $name)) {
    throw new RuntimeException('Unsafe fixture name');
}
if ($input['action'] === 'create') {
    if (Flarum\User\User::where('username', $name)->exists()) {
        throw new RuntimeException('Fixture already exists');
    }
    $user = new Flarum\User\User;
    $user->username = $name;
    $user->email = $name.'@relay-test.example.invalid';
    $user->password = $input['password'];
    $user->joined_at = Carbon\Carbon::now();
    $user->is_email_confirmed = true;
    $user->save();
    // No registration event is dispatched, so no email/notification is sent.
    echo json_encode(['id' => (string) $user->id]);
    exit;
}
$user = Flarum\User\User::findOrFail((int) $input['id']);
if ($user->username !== $name || !str_ends_with($user->email, '@relay-test.example.invalid') || $user->id === 1) {
    throw new RuntimeException('Fixture ownership mismatch');
}
switch ($input['action']) {
case 'rename':
    $user->username = $name.'r';
    $user->save();
    break;
case 'suspend':
    $user->suspended_until = Carbon\Carbon::now()->addHour();
    $user->save();
    break;
case 'unsuspend':
    $user->suspended_until = null;
    $user->save();
    break;
case 'revoke':
    Flarum\Http\AccessToken::where('user_id', $user->id)->delete();
    break;
case 'delete':
    Flarum\Http\AccessToken::where('user_id', $user->id)->delete();
    $user->delete();
    break;
default:
    throw new RuntimeException('Unknown fixture action');
}
echo json_encode(['ok' => true]);
