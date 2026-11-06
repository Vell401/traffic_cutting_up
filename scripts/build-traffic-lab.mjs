import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({ configFile:false, publicDir:false, build:{write:false,minify:true,target:'es2022',lib:{entry:'src/traffic-lab/main.ts',name:'TrafficAtelier',formats:['iife']}} });
const output = (Array.isArray(result)?result[0]:result).output;
const code = output.find(x=>x.type==='chunk').code;
const template = await readFile('src/traffic-lab/template.html','utf8');
await writeFile('traffic-models.html',template.replace('<!--BUNDLE-->',()=>'<script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>'));
console.log('Created standalone traffic-models.html (offline / file:// compatible)');

