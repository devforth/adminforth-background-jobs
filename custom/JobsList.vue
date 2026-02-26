<template>
  <div class="w-1vw md:w-64 bg-white border border-gray-200 rounded-md">
    <div v-for="job in props.jobs" :key="job.id" class="flex flex-col px-4 py-2 border-b border-gray-200 pb-8 hover:bg-gray-50 transition-colors">
      <p class="flex gap-2 items-end text-end"><span class="text-sm h-full">{{ job.name }}</span> <span class="text-xs text-gray-600">{{ getTimeAgoString(new Date(job.createdAt)) }}</span> </p>
      <ProgressBar :current-value="job.progress" :max-value="100" :min-value="0"/>
    </div>
  </div>
</template>


<script setup lang="ts">
import type { IJob } from './utils';
import { getTimeAgoString } from '@/utils';
import { ProgressBar } from '@/afcl';

const props = defineProps<{
  jobs: IJob[];
}>();

  
</script>