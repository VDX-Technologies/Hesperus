-- The greenhouse climate module is no longer called Stoma: module id 'stoma' becomes 'lora'
-- (named "LoRa" in the console). Rows keep their ids, so objects, metrics and alerts stay linked.

update public.org_modules set module = 'lora' where module = 'stoma';
update public.metric_keys set module = 'lora' where module = 'stoma';
update public.object_types set module = 'lora' where module = 'stoma';
update public.object_types set name = '{"en": "LoRa node", "it": "Nodo LoRa"}'
 where module = 'lora' and key = 'node' and tenant_id is null;
update public.event_types set module = 'lora' where module = 'stoma';
update public.rules set module = 'lora' where module = 'stoma';
update public.sources set module = 'lora' where module = 'stoma';
update public.sources set name = 'Simulatore LoRa' where module = 'lora' and name = 'Simulatore Stoma';

-- Machine events only: events recorded by people are immutable (and the module records none).
update public.events set type = 'lora' || substr(type, 6) where type like 'stoma.%' and author is null;
