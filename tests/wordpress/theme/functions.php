<?php
add_action('init', function () {
    foreach (['project' => 'Projects', 'client' => 'Clients', 'vacancy' => 'Vacancies'] as $key => $name) {
        register_post_type($key, ['label' => $name, 'public' => true, 'show_in_rest' => true,
            'has_archive' => $key === 'project', 'rewrite' => ['slug' => $key === 'project' ? 'work' : $key]]);
    }
    register_taxonomy('discipline', 'project', ['label' => 'Disciplines', 'hierarchical' => true, 'public' => true]);
});
add_action('acf/init', function () {
    acf_add_local_field_group(['key' => 'group_pilot', 'title' => 'Project details',
        'location' => [[['param' => 'post_type','operator' => '==','value' => 'project']]],
        'fields' => [
            ['key'=>'field_studio','name'=>'studio','label'=>'Studio','type'=>'text'],
            ['key'=>'field_client','name'=>'client','label'=>'Client','type'=>'post_object','post_type'=>['client']],
            ['key'=>'field_gallery','name'=>'gallery','label'=>'Gallery','type'=>'gallery'],
        ]]);
});
